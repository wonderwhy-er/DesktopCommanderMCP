/**
 * Top-level controller for the File Preview app. It routes structured content into the appropriate renderer, handles host events, and coordinates user-facing state changes.
 */
import { formatJsonIfPossible, inferLanguageFromPath, renderCodeViewer } from './components/code-viewer.js';
import { renderHtmlPreview } from './components/html-renderer.js';
import { renderMarkdown } from './components/markdown-renderer.js';
import { renderToolbar } from './components/toolbar.js';
import { escapeHtml } from './components/highlighting.js';
import type { HtmlPreviewMode, PreviewStructuredContent } from './types.js';
import { createWindowRpcClient, isTrustedParentMessageSource } from '../../shared/rpc-client.js';
import { createToolShellController, type ToolShellController } from '../../shared/tool-shell.js';
import { createUiHostLifecycle } from '../../shared/host-lifecycle.js';
import { createUiThemeAdapter } from '../../shared/theme-adaptation.js';

let isExpanded = false;
let onRender: (() => void) | undefined;
let trackUiEvent: ((event: string, params?: Record<string, unknown>) => void) | undefined;
let rpcCallTool: ((name: string, args: Record<string, unknown>) => Promise<unknown>) | undefined;
let shellController: ToolShellController | undefined;

function getFileExtensionForAnalytics(filePath: string): string {
    const normalizedPath = filePath.trim().replace(/\\/g, '/');
    const fileName = normalizedPath.split('/').pop() ?? normalizedPath;
    const dotIndex = fileName.lastIndexOf('.');
    if (dotIndex <= 0 || dotIndex === fileName.length - 1) {
        return 'none';
    }
    return fileName.slice(dotIndex + 1).toLowerCase();
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isPreviewStructuredContent(value: unknown): value is PreviewStructuredContent {
    if (!isObject(value)) {
        return false;
    }

    return (
        typeof value.fileName === 'string' &&
        typeof value.filePath === 'string' &&
        typeof value.fileType === 'string' &&
        typeof value.content === 'string'
    );
}

function readStructuredContentFromWindow(): PreviewStructuredContent | undefined {
    const candidates: unknown[] = [
        (window as any).__DC_FILE_PREVIEW__,
        (window as any).__MCP_TOOL_RESULT__,
        (window as any).toolResult,
        (window as any).structuredContent
    ];

    for (const candidate of candidates) {
        if (!isObject(candidate)) {
            continue;
        }
        if (isPreviewStructuredContent(candidate.structuredContent)) {
            return candidate.structuredContent;
        }
        if (isPreviewStructuredContent(candidate)) {
            return candidate;
        }
    }

    return undefined;
}

function extractStructuredContent(value: unknown): PreviewStructuredContent | undefined {
    if (!isObject(value)) {
        return undefined;
    }
    if (isPreviewStructuredContent(value.structuredContent)) {
        return value.structuredContent;
    }
    if (isPreviewStructuredContent(value)) {
        return value;
    }
    return undefined;
}

function extractToolText(value: unknown): string | undefined {
    if (!isObject(value)) {
        return undefined;
    }
    const content = value.content;
    if (!Array.isArray(content)) {
        return undefined;
    }
    for (const item of content) {
        if (!isObject(item)) {
            continue;
        }
        if (item.type === 'text' && typeof item.text === 'string' && item.text.trim().length > 0) {
            return item.text;
        }
    }
    return undefined;
}

function extractToolTextFromEvent(value: unknown): string | undefined {
    if (!isObject(value)) {
        return undefined;
    }
    const direct = extractToolText(value);
    if (direct) {
        return direct;
    }
    if (isObject(value.result)) {
        const nested = extractToolText(value.result);
        if (nested) {
            return nested;
        }
    }
    if (isObject(value.params)) {
        const paramsText = extractToolText(value.params);
        if (paramsText) {
            return paramsText;
        }
        if (isObject(value.params.result)) {
            return extractToolText(value.params.result);
        }
    }
    return undefined;
}

function isLikelyUrl(filePath: string): boolean {
    return /^https?:\/\//i.test(filePath);
}

function getParentDirectory(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/');
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash <= 0) {
        return filePath;
    }
    return normalized.slice(0, lastSlash);
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildOpenInFolderCommand(filePath: string): string | undefined {
    const trimmedPath = filePath.trim();
    if (!trimmedPath || isLikelyUrl(trimmedPath)) {
        return undefined;
    }

    const userAgent = navigator.userAgent.toLowerCase();
    if (userAgent.includes('win')) {
        const escaped = trimmedPath.replace(/"/g, '""');
        return `explorer /select,"${escaped}"`;
    }
    if (userAgent.includes('mac')) {
        return `open -R ${shellQuote(trimmedPath)}`;
    }

    return `xdg-open ${shellQuote(getParentDirectory(trimmedPath))}`;
}

function renderRawFallback(source: string): string {
    return `<pre class="code-viewer"><code class="hljs language-text">${escapeHtml(source)}</code></pre>`;
}

function stripReadStatusLine(content: string): string {
    // Remove the synthetic read status header shown by read_file pagination.
    return content.replace(/^\[Reading [^\]]+\]\r?\n?/, '');
}

function renderBody(payload: PreviewStructuredContent, htmlMode: HtmlPreviewMode): { html: string; notice?: string } {
    const cleanedContent = stripReadStatusLine(payload.content);

    if (payload.fileType === 'unsupported') {
        return {
            notice: 'Preview is not available for this file type.',
            html: '<div class="panel-content source-content"></div>'
        };
    }

    if (payload.fileType === 'html') {
        return renderHtmlPreview(cleanedContent, htmlMode);
    }

    if (payload.fileType !== 'markdown') {
        const detectedLanguage = inferLanguageFromPath(payload.filePath);
        const formatted = formatJsonIfPossible(cleanedContent, payload.filePath);
        return {
            notice: formatted.notice,
            html: `<div class="panel-content source-content">${renderCodeViewer(formatted.content, detectedLanguage)}</div>`
        };
    }

    try {
        return {
            html: `<div class="panel-content markdown-content"><article class="markdown markdown-doc">${renderMarkdown(cleanedContent)}</article></div>`
        };
    } catch {
        return {
            notice: 'Markdown renderer failed. Showing raw source instead.',
            html: `<div class="panel-content source-content">${renderRawFallback(cleanedContent)}</div>`
        };
    }
}

function attachCopyHandler(payload: PreviewStructuredContent): void {
    const copyButton = document.getElementById('copy-source');
    if (!copyButton) {
        return;
    }

    const fallbackCopy = (text: string): boolean => {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.setAttribute('readonly', '');
        textArea.style.position = 'fixed';
        textArea.style.top = '-9999px';
        document.body.appendChild(textArea);
        textArea.select();
        const success = document.execCommand('copy');
        document.body.removeChild(textArea);
        return success;
    };

    const setButtonState = (label: string): void => {
        copyButton.setAttribute('title', label);
        copyButton.setAttribute('aria-label', label);
    };

    copyButton.addEventListener('click', async () => {
        const cleanedContent = stripReadStatusLine(payload.content);
        trackUiEvent?.('copy_clicked', {
            file_type: payload.fileType,
            file_extension: getFileExtensionForAnalytics(payload.filePath)
        });

        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(cleanedContent);
                setButtonState('Copied');
                return;
            }
        } catch {
            // fallback below
        }

        const copied = fallbackCopy(cleanedContent);
        setButtonState(copied ? 'Copied' : 'Copy failed');
    });
}

function attachHtmlToggleHandler(container: HTMLElement, payload: PreviewStructuredContent, htmlMode: HtmlPreviewMode): void {
    const toggleButton = document.getElementById('toggle-html-mode');
    if (!toggleButton || payload.fileType !== 'html') {
        return;
    }
    toggleButton.addEventListener('click', () => {
        const nextMode: HtmlPreviewMode = htmlMode === 'rendered' ? 'source' : 'rendered';
        trackUiEvent?.('html_view_toggled', {
            file_type: payload.fileType,
            file_extension: getFileExtensionForAnalytics(payload.filePath)
        });
        renderApp(container, payload, nextMode, isExpanded);
    });
}

function attachOpenInFolderHandler(payload: PreviewStructuredContent): void {
    const openButton = document.getElementById('open-in-folder') as HTMLButtonElement | null;
    if (!openButton) {
        return;
    }

    const command = buildOpenInFolderCommand(payload.filePath);
    if (!command) {
        openButton.disabled = true;
        return;
    }

    openButton.addEventListener('click', async () => {
        trackUiEvent?.('open_in_folder', {
            file_type: payload.fileType,
            file_extension: getFileExtensionForAnalytics(payload.filePath)
        });

        try {
            await rpcCallTool?.('start_process', {
                command,
                timeout_ms: 12000
            });
        } catch {
            // Keep UI stable if opening folder fails.
        }
    });
}

function renderStatusState(container: HTMLElement, message: string): void {
    container.innerHTML = `
      <main class="shell">
        <section class="panel">
          <div class="preview-status">
            <p>${escapeHtml(message)}</p>
          </div>
        </section>
      </main>
    `;
}

function renderLoadingState(container: HTMLElement): void {
    container.innerHTML = `
      <main class="shell">
        <section class="panel">
          <div class="preview-status preview-status--loading">
            <span class="loading-dot" aria-hidden="true"></span>
            <p>Loading preview...</p>
          </div>
        </section>
      </main>
    `;
}

export function renderApp(
    container: HTMLElement,
    payload?: PreviewStructuredContent,
    htmlMode: HtmlPreviewMode = 'rendered',
    expandedState = false
): void {
    isExpanded = expandedState;
    shellController?.dispose();
    shellController = undefined;

    if (!payload) {
        renderStatusState(container, 'No preview available for this response.');
        onRender?.();
        return;
    }

    const canCopy = payload.fileType !== 'unsupported';
    const canOpenInFolder = !isLikelyUrl(payload.filePath);
    const fileExtension = getFileExtensionForAnalytics(payload.filePath);
    const body = renderBody(payload, htmlMode);
    const notice = body.notice ? `<div class="notice">${body.notice}</div>` : '';

    container.innerHTML = `
      <main id="tool-shell" class="shell tool-shell ${isExpanded ? 'expanded' : 'collapsed'}">
        ${renderToolbar(payload, canCopy, htmlMode, isExpanded, canOpenInFolder)}
        <section class="panel">
          ${notice}
          ${body.html}
        </section>
      </main>
    `;
    attachCopyHandler(payload);
    attachHtmlToggleHandler(container, payload, htmlMode);
    attachOpenInFolderHandler(payload);
    shellController = createToolShellController({
        shell: document.getElementById('tool-shell'),
        toggleButton: payload.fileType === 'unsupported' ? null : (document.getElementById('toggle-expand') as HTMLButtonElement | null),
        initialExpanded: isExpanded,
        onToggle: (expanded) => {
            isExpanded = expanded;
            trackUiEvent?.(expanded ? 'expand' : 'collapse', {
                file_type: payload.fileType,
                file_extension: fileExtension
            });
        },
        onScrollAfterExpand: () => {
            trackUiEvent?.('scroll_after_expand', {
                file_type: payload.fileType,
                file_extension: fileExtension
            });
        },
        onRender
    });
    onRender?.();
}

export function bootstrapApp(): void {
    const container = document.getElementById('app');
    if (!container) {
        return;
    }
    renderLoadingState(container);

    const rpcClient = createWindowRpcClient({
        targetWindow: window.parent,
        timeoutMs: 15000,
        isTrustedSource: (source) => isTrustedParentMessageSource(source, window.parent)
    });
    const hostLifecycle = createUiHostLifecycle(rpcClient, {
        appName: 'Desktop Commander File Preview',
        appVersion: '1.0.0'
    });
    const themeAdapter = createUiThemeAdapter();

    rpcCallTool = (name: string, args: Record<string, unknown>): Promise<unknown> => (
        rpcClient.request('tools/call', {
            name,
            arguments: args
        })
    );

    trackUiEvent = (event: string, params: Record<string, unknown> = {}): void => {
        void rpcCallTool?.('track_ui_event', {
            event,
            component: 'file_preview',
            params: {
                tool_name: 'read_file',
                ...params
            }
        }).catch(() => {
            // Analytics failures should not impact UX.
        });
    };

    onRender = () => {
        hostLifecycle.notifyRender();
    };

    onRender?.();
    themeAdapter.applyFromData((window as any).__MCP_HOST_CONTEXT__);
    const renderAndSync = (payload?: PreviewStructuredContent): void => {
        renderApp(container, payload, 'rendered', false);
    };
    let initialStateResolved = false;
    const resolveInitialState = (payload?: PreviewStructuredContent, message?: string): void => {
        if (initialStateResolved) {
            return;
        }
        initialStateResolved = true;
        if (payload) {
            renderAndSync(payload);
            return;
        }
        renderStatusState(container, message ?? 'No preview available for this response.');
        onRender?.();
    };

    const initialPayload = readStructuredContentFromWindow();
    if (initialPayload) {
        window.setTimeout(() => {
            resolveInitialState(initialPayload);
        }, 140);
    }

    window.addEventListener('message', (event) => {
        try {
        if (rpcClient.handleMessageEvent(event)) {
            return;
        }
        if (!isTrustedParentMessageSource(event.source, window.parent)) {
            return;
        }
        if (!isObject(event.data)) {
            return;
        }
        themeAdapter.applyFromData(event.data);

        if (event.data.method === 'ui/notifications/tool-result') {
            const params = event.data.params;
            const candidate = isObject(params) && isObject(params.result) ? params.result : params;
            const payload = extractStructuredContent(candidate);
            const message = extractToolTextFromEvent(event.data) ?? extractToolText(candidate);
            if (!initialStateResolved) {
                if (payload) {
                    renderLoadingState(container);
                    onRender?.();
                    window.setTimeout(() => resolveInitialState(payload), 120);
                    return;
                }
                if (message) {
                    resolveInitialState(undefined, message);
                }
                return;
            }
            if (payload) {
                renderAndSync(payload);
            } else if (message) {
                renderStatusState(container, message);
                onRender?.();
            }
            return;
        }

        const payload = extractStructuredContent(event.data);
        if (payload) {
            if (!initialStateResolved) {
                resolveInitialState(payload);
                return;
            }
            renderAndSync(payload);
        }
        } catch {
            renderStatusState(container, 'Preview failed to render.');
            onRender?.();
        }
    });

    hostLifecycle.observeResize();
    window.addEventListener('beforeunload', () => {
        shellController?.dispose();
        rpcClient.dispose();
    }, { once: true });
    hostLifecycle.initialize();
}
