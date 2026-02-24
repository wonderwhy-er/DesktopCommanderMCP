/**
 * Top-level controller for the File Preview app. It routes structured content into the appropriate renderer, handles host events, and coordinates user-facing state changes.
 */
import { formatJsonIfPossible, inferLanguageFromPath, renderCodeViewer } from './components/code-viewer.js';
import { renderHtmlPreview } from './components/html-renderer.js';
import { renderMarkdown } from './components/markdown-renderer.js';
import { escapeHtml } from './components/highlighting.js';
import { isAllowedImageMimeType, normalizeImageMimeType } from './image-preview.js';
import type { FilePreviewStructuredContent } from '../../../types.js';
import type { HtmlPreviewMode } from './types.js';
import { createToolShellController, type ToolShellController } from '../../shared/tool-shell.js';
import { createWidgetStateStorage } from '../../shared/widget-state.js';
import { App, applyDocumentTheme, applyHostStyleVariables, applyHostFonts } from '@modelcontextprotocol/ext-apps';

let isExpanded = false;
let hideSummaryRow = false;
let previewShownFired = false;
let onRender: (() => void) | undefined;
let trackUiEvent: ((event: string, params?: Record<string, unknown>) => void) | undefined;
let rpcCallTool: ((name: string, args: Record<string, unknown>) => Promise<unknown>) | undefined;
let rpcUpdateContext: ((text: string) => void) | undefined;
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

// Internal type used only for rendering — extends the public type with the
// text content sourced from the MCP content array (not structuredContent).
type RenderPayload = FilePreviewStructuredContent & { content: string };

function isPreviewStructuredContent(value: unknown): value is FilePreviewStructuredContent {
    if (!isObject(value)) {
        return false;
    }

    return (
        typeof value.fileName === 'string' &&
        typeof value.filePath === 'string' &&
        typeof value.fileType === 'string'
    );
}

function buildRenderPayload(
    meta: FilePreviewStructuredContent,
    text: string
): RenderPayload {
    return { ...meta, content: text };
}

function extractRenderPayload(value: unknown): RenderPayload | undefined {
    if (!isObject(value)) {
        return undefined;
    }
    const meta = isPreviewStructuredContent(value.structuredContent)
        ? value.structuredContent
        : isPreviewStructuredContent(value)
            ? value
            : null;
    if (!meta) return undefined;
    const text = extractToolText(value) ?? extractToolText(value.structuredContent) ?? '';
    return buildRenderPayload(meta, text);
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

function isLikelyUrl(filePath: string): boolean {
    return /^https?:\/\//i.test(filePath);
}

function buildBreadcrumb(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    // Show last 3-4 meaningful segments as breadcrumb
    const tail = parts.slice(-4);
    return tail.map(p => escapeHtml(p)).join(' <span class="breadcrumb-sep">›</span> ');
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

function encodePowerShellCommand(script: string): string {
    // PowerShell -EncodedCommand expects UTF-16LE bytes.
    const utf16leBytes: number[] = [];
    for (let index = 0; index < script.length; index += 1) {
        const codeUnit = script.charCodeAt(index);
        utf16leBytes.push(codeUnit & 0xff, codeUnit >> 8);
    }

    let binary = '';
    for (const byte of utf16leBytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

function buildOpenInFolderCommand(filePath: string): string | undefined {
    const trimmedPath = filePath.trim();
    if (!trimmedPath || isLikelyUrl(trimmedPath)) {
        return undefined;
    }

    const userAgent = navigator.userAgent.toLowerCase();
    if (userAgent.includes('win')) {
        const escapedForPowerShell = trimmedPath.replace(/'/g, "''");
        const script = `Start-Process -FilePath explorer.exe -ArgumentList @('/select,','${escapedForPowerShell}')`;
        return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodePowerShellCommand(script)}`;
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

function renderImageBody(payload: RenderPayload): { html: string; notice?: string } {
    const mimeType = normalizeImageMimeType(payload.mimeType);
    if (!isAllowedImageMimeType(mimeType)) {
        return {
            notice: 'Preview is unavailable for this image format.',
            html: '<div class="panel-content source-content"></div>'
        };
    }

    if (!payload.imageData || payload.imageData.trim().length === 0) {
        return {
            notice: 'Preview is unavailable because image data is missing.',
            html: '<div class="panel-content source-content"></div>'
        };
    }

    const src = `data:${mimeType};base64,${payload.imageData}`;
    return {
        html: `<div class="panel-content image-content"><div class="image-preview"><img src="${escapeHtml(src)}" alt="${escapeHtml(payload.fileName)}" loading="eager" decoding="async"></div></div>`
    };
}

function countContentLines(content: string): number {
    const cleaned = stripReadStatusLine(content);
    if (cleaned === '') return 0;
    const lines = cleaned.split('\n');
    return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

interface ReadRange {
    fromLine: number;
    toLine: number;
    totalLines: number;
    isPartial: boolean;
}

function parseReadRange(content: string): ReadRange | undefined {
    // Parse "[Reading N lines from line M (total: T lines, R remaining)]"
    // or    "[Reading N lines from start (total: T lines, R remaining)]"
    const match = content.match(/^\[Reading (\d+) lines from (?:line )?(\d+|start) \(total: (\d+) lines/);
    if (!match) return undefined;
    const count = parseInt(match[1], 10);
    const from = match[2] === 'start' ? 1 : parseInt(match[2], 10);
    const total = parseInt(match[3], 10);
    return {
        fromLine: from,
        toLine: from + count - 1,
        totalLines: total,
        isPartial: count < total
    };
}

function renderBody(payload: RenderPayload, htmlMode: HtmlPreviewMode, startLine = 1): { html: string; notice?: string } {
    const cleanedContent = stripReadStatusLine(payload.content);

    if (payload.fileType === 'image') {
        return renderImageBody(payload);
    }

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
            html: `<div class="panel-content source-content">${renderCodeViewer(formatted.content, detectedLanguage, startLine)}</div>`
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

function attachCopyHandler(payload: RenderPayload): void {
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

    const setButtonState = (label: string, revertMs?: number): void => {
        copyButton.setAttribute('title', label);
        copyButton.setAttribute('aria-label', label);
        copyButton.textContent = label;
        if (revertMs) {
            setTimeout(() => {
                copyButton.textContent = 'Copy';
                copyButton.setAttribute('title', 'Copy source');
                copyButton.setAttribute('aria-label', 'Copy source');
            }, revertMs);
        }
    };

    const copyTextData = async (text: string): Promise<boolean> => {
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                return true;
            }
            return fallbackCopy(text);
        } catch {
            return fallbackCopy(text);
        }
    };

    copyButton.addEventListener('click', async () => {
        trackUiEvent?.('copy_clicked', {
            file_type: payload.fileType,
            file_extension: getFileExtensionForAnalytics(payload.filePath)
        });

        const cleanedContent = stripReadStatusLine(payload.content);

        const copied = await copyTextData(cleanedContent);
        setButtonState(copied ? 'Copied!' : 'Copy failed', 1500);
    });
}

function attachHtmlToggleHandler(container: HTMLElement, payload: RenderPayload, htmlMode: HtmlPreviewMode): void {
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

function attachOpenInFolderHandler(payload: RenderPayload): void {
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

function attachLoadAllHandler(
    container: HTMLElement,
    payload: RenderPayload,
    htmlMode: HtmlPreviewMode
): void {
    const beforeBtn = document.getElementById('load-before') as HTMLButtonElement | null;
    const afterBtn = document.getElementById('load-after') as HTMLButtonElement | null;
    if (!beforeBtn && !afterBtn) {
        return;
    }

    const range = parseReadRange(payload.content);
    if (!range?.isPartial) return;

    const currentContent = stripReadStatusLine(payload.content);

    const loadLines = async (btn: HTMLButtonElement, direction: 'before' | 'after'): Promise<void> => {
        const originalText = btn.textContent;
        btn.textContent = 'Loading…';
        btn.disabled = true;

        trackUiEvent?.(direction === 'before' ? 'load_lines_before' : 'load_lines_after', {
            file_type: payload.fileType,
            file_extension: getFileExtensionForAnalytics(payload.filePath)
        });

        try {
            // Load only the missing portion
            const readArgs = direction === 'before'
                ? { path: payload.filePath, offset: 0, length: range.fromLine - 1 }
                : { path: payload.filePath, offset: range.toLine };

            const result = await rpcCallTool?.('read_file', readArgs);
            const resultObj = result as { content?: Array<{ text?: string }> } | undefined;
            const newText = resultObj?.content?.[0]?.text;

            if (newText && typeof newText === 'string') {
                const cleanNew = stripReadStatusLine(newText);

                // Merge: prepend or append the new lines
                const merged = direction === 'before'
                    ? cleanNew + (cleanNew.endsWith('\n') ? '' : '\n') + currentContent
                    : currentContent + (currentContent.endsWith('\n') ? '' : '\n') + cleanNew;

                // Build updated status line reflecting the new range
                const newFrom = direction === 'before' ? 1 : range.fromLine;
                const newTo = direction === 'after' ? range.totalLines : range.toLine;
                const lineCount = newTo - newFrom + 1;
                const remaining = range.totalLines - newTo;
                const isStillPartial = newFrom > 1 || newTo < range.totalLines;
                const statusLine = isStillPartial
                    ? `[Reading ${lineCount} lines from ${newFrom === 1 ? 'start' : `line ${newFrom}`} (total: ${range.totalLines} lines, ${remaining} remaining)]\n`
                    : '';

                const mergedPayload: RenderPayload = {
                    ...payload,
                    content: statusLine + merged
                };
                renderApp(container, mergedPayload, htmlMode, isExpanded);
            } else {
                btn.textContent = 'Failed to load';
                setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 2000);
            }
        } catch {
            btn.textContent = 'Failed to load';
            setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 2000);
        }
    };

    beforeBtn?.addEventListener('click', () => void loadLines(beforeBtn, 'before'));
    afterBtn?.addEventListener('click', () => void loadLines(afterBtn, 'after'));
}

/**
 * Tracks native text selection and pushes it to the host via ui/update-model-context.
 *
 * How it works:
 * 1. User drags to select text anywhere in the preview (markdown, code, HTML).
 * 2. The selectionchange event fires; we extract the selected string.
 * 3. We call rpcUpdateContext() which sends a ui/update-model-context JSON-RPC
 *    request to the host with the selected text + file path (+ line numbers for code).
 * 4. The host stores this as widget context.
 * 5. The LLM can access it by calling read_widget_context(tool_name="desktop-commander:read_file").
 *
 * Note: as of Feb 2025, Claude does NOT auto-inject ui/update-model-context into
 * the LLM's context window. The LLM must actively call read_widget_context to see
 * the selection. A floating tooltip near the selection tells the user this is working.
 */
let selectionAbortController: AbortController | null = null;

function attachTextSelectionHandler(payload: RenderPayload): void {
    const contentWrapper = document.querySelector('.panel-content-wrapper') as HTMLElement | null;
    if (!contentWrapper) return;

    // Abort any previous selectionchange listener to avoid leaking listeners/closures
    if (selectionAbortController) {
        selectionAbortController.abort();
        selectionAbortController = null;
    }
    selectionAbortController = new AbortController();

    let hintEl: HTMLElement | null = null;
    let lastSelectedText = '';
    let hideTimer: ReturnType<typeof setTimeout> | null = null;

    function positionHint(selection: Selection): void {
        if (!hintEl) return;
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        const wrapperRect = contentWrapper!.getBoundingClientRect();

        // Position above the selection, centered horizontally
        let left = rect.left + rect.width / 2 - wrapperRect.left;
        let top = rect.top - wrapperRect.top + contentWrapper!.scrollTop - 32;

        // Clamp within wrapper bounds
        const hintWidth = hintEl.offsetWidth || 200;
        left = Math.max(8, Math.min(left - hintWidth / 2, contentWrapper!.clientWidth - hintWidth - 8));
        top = Math.max(4, top);

        hintEl.style.left = `${left}px`;
        hintEl.style.top = `${top}px`;
    }

    function showHint(selection: Selection): void {
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }

        if (!hintEl) {
            hintEl = document.createElement('div');
            hintEl.className = 'selection-hint';
            hintEl.textContent = 'AI can see your selection';
            contentWrapper!.appendChild(hintEl);
        }
        hintEl.classList.add('visible');
        positionHint(selection);
    }

    function hideHint(): void {
        if (!hintEl) return;
        hintEl.classList.remove('visible');
        hideTimer = setTimeout(() => { hintEl?.remove(); hintEl = null; }, 200);
    }

    function getLineInfo(selection: Selection): string {
        const anchorRow = selection.anchorNode?.parentElement?.closest('.code-line') as HTMLElement | null;
        const focusRow = selection.focusNode?.parentElement?.closest('.code-line') as HTMLElement | null;
        if (anchorRow && focusRow) {
            const a = parseInt(anchorRow.dataset.line ?? '', 10);
            const f = parseInt(focusRow.dataset.line ?? '', 10);
            if (!isNaN(a) && !isNaN(f)) {
                const low = Math.min(a, f);
                const high = Math.max(a, f);
                return low === high ? `line ${low}` : `lines ${low}–${high}`;
            }
        }
        return '';
    }

    document.addEventListener('selectionchange', () => {
        const selection = document.getSelection();
        if (!selection || selection.isCollapsed) {
            if (lastSelectedText) {
                lastSelectedText = '';
                rpcUpdateContext?.('');
                hideHint();
            }
            return;
        }

        const text = selection.toString().trim();
        if (!text || text === lastSelectedText) return;

        // Only act on selections within our content area
        const anchorInContent = contentWrapper!.contains(selection.anchorNode);
        const focusInContent = contentWrapper!.contains(selection.focusNode);
        if (!anchorInContent && !focusInContent) {
            if (lastSelectedText) {
                lastSelectedText = '';
                rpcUpdateContext?.('');
                hideHint();
            }
            return;
        }

        lastSelectedText = text;

        const lineInfo = getLineInfo(selection);
        const locationPart = lineInfo ? ` (${lineInfo})` : '';
        const context = `User selected text from file ${payload.filePath}${locationPart}:\n\`\`\`\n${text}\n\`\`\``;

        rpcUpdateContext?.(context);
        showHint(selection);

        trackUiEvent?.('text_selected', {
            file_type: payload.fileType,
            file_extension: getFileExtensionForAnalytics(payload.filePath),
            char_count: text.length
        });
    }, { signal: selectionAbortController!.signal });
}


function renderStatusState(container: HTMLElement, message: string): void {
    container.innerHTML = `
      <main class="shell">
        <div class="compact-row compact-row--status">
          <span class="compact-label">${escapeHtml(message)}</span>
        </div>
      </main>
    `;
    document.body.classList.add('dc-ready');
}

function renderLoadingState(container: HTMLElement): void {
    container.innerHTML = `
      <main class="shell">
        <div class="compact-row compact-row--loading">
          <span class="compact-label">Preparing preview…</span>
        </div>
      </main>
    `;
    document.body.classList.add('dc-ready');
}

export function renderApp(
    container: HTMLElement,
    payload?: RenderPayload,
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

    const canCopy = payload.fileType !== 'unsupported' && payload.fileType !== 'image';
    const canOpenInFolder = !isLikelyUrl(payload.filePath);
    const fileExtension = getFileExtensionForAnalytics(payload.filePath);
    const supportsPreview = payload.fileType !== 'unsupported';

    // In DC app (hideSummaryRow), no reason to auto-expand when there's nothing to preview —
    // the host header already shows the file name and path.
    if (!supportsPreview && hideSummaryRow) {
        isExpanded = false;
    }
    const range = parseReadRange(payload.content);
    const body = renderBody(payload, htmlMode, range?.fromLine ?? 1);
    const notice = body.notice ? `<div class="notice">${body.notice}</div>` : '';

    const breadcrumb = buildBreadcrumb(payload.filePath);
    const lineCount = range ? range.toLine - range.fromLine + 1 : countContentLines(payload.content);
    const fileTypeLabel = payload.fileType === 'markdown' ? 'MARKDOWN'
        : payload.fileType === 'html' ? 'HTML'
        : payload.fileType === 'image' ? 'IMAGE'
        : fileExtension !== 'none' ? fileExtension.toUpperCase()
        : 'TEXT';

    const compactLabel = range?.isPartial
        ? `View lines ${range.fromLine}–${range.toLine}`
        : 'View file';
    const footerLabel = range?.isPartial
        ? `${escapeHtml(fileTypeLabel)} • LINES ${range.fromLine}–${range.toLine} OF ${range.totalLines}`
        : `${escapeHtml(fileTypeLabel)} • ${lineCount} LINE${lineCount !== 1 ? 'S' : ''}`;

    const htmlToggle = payload.fileType === 'html'
        ? `<button class="panel-action" id="toggle-html-mode">${htmlMode === 'rendered' ? 'Source' : 'Rendered'}</button>`
        : '';

    const copyIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
    const folderIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
    
    // Content-area banners for missing lines
    const hasMissingBefore = range?.isPartial && range.fromLine > 1;
    const hasMissingAfter = range?.isPartial && range.toLine < range.totalLines && (range.totalLines - range.toLine) > 1;
    const loadBeforeBanner = hasMissingBefore
        ? `<button class="load-lines-banner" id="load-before">↑ Load lines 1–${range!.fromLine - 1}</button>`
        : '';
    const loadAfterBanner = hasMissingAfter
        ? `<button class="load-lines-banner" id="load-after">↓ Load lines ${range!.toLine + 1}–${range!.totalLines}</button>`
        : '';

    container.innerHTML = `
      <main id="tool-shell" class="shell tool-shell ${isExpanded ? 'expanded' : 'collapsed'}${hideSummaryRow ? ' host-framed' : ''}">
        <div class="compact-row compact-row--ready" id="compact-toggle" role="button" tabindex="0" aria-expanded="${isExpanded}">
          <svg class="compact-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 6l6 6-6 6z"/></svg>
          <span class="compact-label">${compactLabel}</span>
          <span class="compact-filename">${escapeHtml(payload.fileName)}</span>
        </div>
        <section class="panel">
          <div class="panel-topbar">
            <span class="panel-breadcrumb" title="${escapeHtml(payload.filePath)}">${breadcrumb}</span>
            <span class="panel-topbar-actions">
              ${htmlToggle}
              ${canOpenInFolder ? `<button class="panel-action" id="open-in-folder">${folderIcon} Open in folder</button>` : ''}
              ${canCopy && supportsPreview ? `<button class="panel-action" id="copy-source" title="Copy source" aria-label="Copy source">${copyIcon} Copy</button>` : ''}
            </span>
          </div>
          ${notice}
          <div class="panel-content-wrapper">
            ${loadBeforeBanner}
            ${body.html}
            ${loadAfterBanner}
          </div>
          <div class="panel-footer">
            <span>${footerLabel}</span>
          </div>
        </section>
      </main>
    `;
    document.body.classList.add('dc-ready');
    attachCopyHandler(payload);
    attachHtmlToggleHandler(container, payload, htmlMode);
    attachOpenInFolderHandler(payload);
    attachLoadAllHandler(container, payload, htmlMode);
    attachTextSelectionHandler(payload);

    // Compact row click toggles expand/collapse
    const compactRow = document.getElementById('compact-toggle');
    const handleCompactClick = (): void => {
        shellController?.toggle();
    };
    const handleCompactKeydown = (e: KeyboardEvent): void => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            shellController?.toggle();
        }
    };
    compactRow?.addEventListener('click', handleCompactClick);
    compactRow?.addEventListener('keydown', handleCompactKeydown);

    shellController = createToolShellController({
        shell: document.getElementById('tool-shell'),
        toggleButton: null, // No separate toggle button; compact row handles it
        initialExpanded: isExpanded,
        onToggle: (expanded) => {
            isExpanded = expanded;
            compactRow?.setAttribute('aria-expanded', String(expanded));
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
    if (!previewShownFired) {
        previewShownFired = true;
        trackUiEvent?.('preview_shown', {
            file_type: payload.fileType,
            file_extension: fileExtension
        });
    }
}

function applyHostCtx(ctx: unknown): void {
    const c = ctx as any;
    if (c?.theme === 'light' || c?.theme === 'dark') applyDocumentTheme(c.theme);
    if (c?.styles?.variables) applyHostStyleVariables(c.styles.variables);
    if (c?.styles?.css?.fonts) applyHostFonts(c.styles.css.fonts);

    // Hosts may pass additional flags via hostContext (forward-compatible index signature)
    const extra = c;
    if (typeof extra.initiallyExpanded === 'boolean') {
        isExpanded = extra.initiallyExpanded;
    }
    if (typeof extra.hideSummaryRow === 'boolean') {
        hideSummaryRow = extra.hideSummaryRow;
        if (hideSummaryRow) isExpanded = true;
    }
}

export function bootstrapApp(): void {
    const container = document.getElementById('app');
    if (!container) {
        return;
    }
    renderLoadingState(container);

    // Use the official App class – it connects to the host via PostMessageTransport
    // (window.parent by default) and speaks standard MCP JSON-RPC 2.0 over postMessage.
    const app = new App(
        { name: 'Desktop Commander File Preview', version: '1.0.0' },
        { updateModelContext: { text: {} } },
        { autoResize: true },
    );

    // Widget state for cross-host persistence (survives page refresh)
    const widgetState = createWidgetStateStorage<RenderPayload>(
        (v): v is RenderPayload => isPreviewStructuredContent(v) && typeof (v as any).content === 'string'
    );

    const renderAndSync = (payload?: RenderPayload): void => {
        if (payload) {
            widgetState.write(payload);
        }
        renderApp(container, payload, 'rendered', isExpanded);
    };

    let initialStateResolved = false;
    const resolveInitialState = (payload?: RenderPayload, message?: string): void => {
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

    // autoResize handles size reporting; onRender can be a no-op
    onRender = () => {};

    // Wire rpcCallTool through the App's callServerTool proxy
    rpcCallTool = (name: string, args: Record<string, unknown>): Promise<unknown> => (
        app.callServerTool({ name, arguments: args })
    );

    // Wire rpcUpdateContext through the App's updateModelContext
    rpcUpdateContext = (text: string): void => {
        const params = text
            ? { content: [{ type: 'text' as const, text }] }
            : { content: [] as [] };
        app.updateModelContext(params).catch(() => {
            // Host may not support updateModelContext
        });
    };

    trackUiEvent = (event: string, params: Record<string, unknown> = {}): void => {
        void rpcCallTool?.('track_ui_event', {
            event,
            component: 'file_preview',
            params: { tool_name: 'read_file', ...params }
        }).catch(() => {});
    };

    // Register ALL handlers BEFORE connect
    app.onhostcontextchanged = (ctx) => {
        applyHostCtx(ctx);
    };

    app.onteardown = async () => {
        shellController?.dispose();
        return {};
    };

    app.ontoolinput = (_params) => {
        // Tool is executing – show loading state
        renderLoadingState(container);
        onRender?.();
    };

    app.ontoolresult = (result) => {
        const payload = extractRenderPayload(result);
        const message = extractToolText(result as unknown as Record<string, unknown>);
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
    };

    app.ontoolcancelled = (params) => {
        resolveInitialState(undefined, params.reason ?? 'Tool was cancelled.');
    };

    // Connect to the host (defaults to window.parent via PostMessageTransport)
    app.connect().then(() => {
        // Apply initial host context received during the initialization handshake
        const ctx = app.getHostContext();
        if (ctx) {
            applyHostCtx(ctx);
        }

        // Try to restore from persisted widget state (survives refresh on some hosts)
        const cachedPayload = widgetState.read();
        if (cachedPayload) {
            window.setTimeout(() => resolveInitialState(cachedPayload), 50);
        }

        // Fallback: if no tool data arrives, show a helpful status message
        window.setTimeout(() => {
            if (!initialStateResolved) {
                resolveInitialState(
                    undefined,
                    'Preview unavailable after page refresh. Switch threads or re-run the tool.'
                );
            }
        }, 8000);
    }).catch(() => {
        renderStatusState(container, 'Failed to connect to host.');
        onRender?.();
    });

    window.addEventListener('beforeunload', () => {
        shellController?.dispose();
    }, { once: true });
}
