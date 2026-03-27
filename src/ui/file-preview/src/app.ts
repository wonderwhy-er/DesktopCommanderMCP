/**
 * Top-level controller for the File Preview app. It routes structured content into the appropriate renderer, handles host events, and coordinates user-facing state changes.
 */
import { formatJsonIfPossible, inferLanguageFromPath, renderCodeViewer } from './components/code-viewer.js';
import { renderHtmlPreview } from './components/html-renderer.js';
import { escapeHtml } from './components/highlighting.js';
import { isAllowedImageMimeType, normalizeImageMimeType } from './image-preview.js';
import { mountMarkdownEditor, renderMarkdownCopyButton, renderMarkdownEditorShell, renderMarkdownModeToggle, type MarkdownEditorHandle, type MarkdownEditorView, type MarkdownLinkHeading, type MarkdownLinkSearchItem } from './markdown-workspace/editor.js';
import { resolveMarkdownLink } from './markdown-workspace/linking.js';
import { extractMarkdownOutline } from './markdown-workspace/outline.js';
import { getRenderedMarkdownCopyText, renderMarkdownWorkspacePreview } from './markdown-workspace/preview.js';
import { slugifyMarkdownHeading } from './markdown-workspace/slugify.js';
import { attachMarkdownToc, renderMarkdownToc, type MarkdownTocHandle } from './markdown-workspace/toc.js';
import { getMarkdownEditAvailability, getMarkdownFullscreenAvailability, parseReadRange, shouldAutoLoadMarkdownOnEnterFullscreen, stripReadStatusLine } from './markdown-workspace/workspace-controller.js';
import type { FilePreviewStructuredContent } from '../../../types.js';
import type { HtmlPreviewMode } from './types.js';
import { createCompactRowShellController, type ToolShellController } from '../../shared/tool-shell.js';
import { createWidgetStateStorage } from '../../shared/widget-state.js';
import { renderCompactRow } from '../../shared/compact-row.js';
import { connectWithSharedHostContext, isObjectRecord, type UiChromeState } from '../../shared/host-context.js';
import { createUiEventTracker } from '../../shared/ui-event-tracker.js';
import { App } from '@modelcontextprotocol/ext-apps';

let isExpanded = false;
let hideSummaryRow = false;
let previewShownFired = false;
let onRender: (() => void) | undefined;
let trackUiEvent: ((event: string, params?: Record<string, unknown>) => void) | undefined;
let rpcCallTool: ((name: string, args: Record<string, unknown>) => Promise<unknown>) | undefined;
let rpcUpdateContext: ((text: string) => void) | undefined;
let openExternalLink: ((url: string) => Promise<boolean>) | undefined;
let requestDisplayMode: ((mode: 'inline' | 'fullscreen') => Promise<string | null>) | undefined;
let shellController: ToolShellController | undefined;
let currentPayload: RenderPayload | undefined;
let currentHtmlMode: HtmlPreviewMode = 'rendered';
let currentHostContext: Record<string, unknown> | undefined;
let rerenderCurrent: (() => void) | undefined;
let syncPayload: ((payload?: RenderPayload) => void) | undefined;
let persistPayload: ((payload: RenderPayload) => void) | undefined;
let markdownEditorHandle: MarkdownEditorHandle | undefined;
let markdownTocHandle: MarkdownTocHandle | undefined;
let localPayloadOverride: RenderPayload | undefined;
const markdownEditorAppCache = new Map<string, { appName: string; appPath?: string }>();
const markdownEditorAppPending = new Set<string>();

interface MarkdownWorkspaceState {
    filePath: string;
    initialContent: string;
    sourceContent: string;
    fullDocumentContent: string;
    draftContent: string;
    mode: 'preview' | 'edit';
    dirty: boolean;
    activeHeadingId: string | null;
    pendingAnchor: string | null;
    notice: string | null;
    error: string | null;
    saving: boolean;
    loadingDocument: boolean;
    editorView: MarkdownEditorView;
    editorScrollTop: number;
    saveIndicator: 'idle' | 'saving' | 'saved';
    fileDeleted: boolean;
}

let markdownWorkspaceState: MarkdownWorkspaceState | undefined;

function getFileExtensionForAnalytics(filePath: string): string {
    const normalizedPath = filePath.trim().replace(/\\/g, '/');
    const fileName = normalizedPath.split('/').pop() ?? normalizedPath;
    const dotIndex = fileName.lastIndexOf('.');
    if (dotIndex <= 0 || dotIndex === fileName.length - 1) {
        return 'none';
    }
    return fileName.slice(dotIndex + 1).toLowerCase();
}

// Internal type used only for rendering — extends the public type with the
// text content sourced from the MCP content array (not structuredContent).
type RenderPayload = FilePreviewStructuredContent & { content: string };

function isPreviewStructuredContent(value: unknown): value is FilePreviewStructuredContent {
    if (!isObjectRecord(value)) {
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
    if (!isObjectRecord(value)) {
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
    if (!isObjectRecord(value)) {
        return undefined;
    }
    const content = value.content;
    if (!Array.isArray(content)) {
        return undefined;
    }
    for (const item of content) {
        if (!isObjectRecord(item)) {
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
    return parts.map(p => escapeHtml(p)).join(' <span class="breadcrumb-sep">›</span> ');
}

function getParentDirectory(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/');
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash <= 0) {
        return filePath;
    }
    return normalized.slice(0, lastSlash);
}

function getAncestorDirectories(filePath: string): string[] {
    const normalized = filePath.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    const ancestors: string[] = [];
    for (let index = parts.length - 1; index > 0; index -= 1) {
        const prefix = normalized.startsWith('/') ? '/' : '';
        ancestors.push(`${prefix}${parts.slice(0, index).join('/')}`);
    }
    return ancestors;
}

function parseDirectoryEntries(text: string): string[] {
    return text.split('\n').map((line) => line.trim()).filter(Boolean);
}

function parseFileSearchResults(text: string): string[] {
    return text.split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('📁 '))
        .map((line) => line.slice(3).trim());
}

function toPosixRelativePath(fromDirectory: string, targetPath: string): string {
    const fromParts = fromDirectory.replace(/\\/g, '/').split('/').filter(Boolean);
    const targetParts = targetPath.replace(/\\/g, '/').split('/').filter(Boolean);
    let shared = 0;
    while (shared < fromParts.length && shared < targetParts.length && fromParts[shared] === targetParts[shared]) {
        shared += 1;
    }
    const up = new Array(Math.max(fromParts.length - shared, 0)).fill('..');
    const down = targetParts.slice(shared);
    const joined = [...up, ...down].join('/');
    return joined.length > 0 ? joined : '.';
}

function stripMarkdownExtension(filePath: string): string {
    return filePath.replace(/\.md$/i, '');
}

async function resolveMarkdownLinkSearchRoot(filePath: string): Promise<string> {
    const ancestors = getAncestorDirectories(filePath);
    const markers = ['.git/', '.obsidian/', 'package.json', 'pnpm-workspace.yaml', 'turbo.json'];

    for (const ancestor of ancestors) {
        try {
            const result = await rpcCallTool?.('list_directory', { path: ancestor, depth: 1 });
            const text = extractToolText(result) ?? '';
            const entries = parseDirectoryEntries(text);
            if (markers.some((marker) => entries.some((entry) => entry.includes(marker)))) {
                return ancestor;
            }
        } catch {
            // Ignore and continue up the tree.
        }
    }

    return getParentDirectory(filePath);
}

async function searchMarkdownLinkTargets(filePath: string, query: string): Promise<MarkdownLinkSearchItem[]> {
    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0) {
        return [];
    }

    const rootPath = await resolveMarkdownLinkSearchRoot(filePath);
    const result = await rpcCallTool?.('start_search', {
        path: rootPath,
        pattern: trimmedQuery,
        searchType: 'files',
        filePattern: '*.md',
        maxResults: 20,
        earlyTermination: false,
        literalSearch: true,
    });
    const text = extractToolText(result) ?? '';
    const filePaths = parseFileSearchResults(text);
    const currentDirectory = getParentDirectory(filePath);

    return filePaths.map((targetPath) => {
        const normalized = targetPath.replace(/\\/g, '/');
        const fileName = normalized.split('/').pop() ?? normalized;
        const title = stripMarkdownExtension(fileName);
        const relativePath = toPosixRelativePath(currentDirectory, normalized);
        const wikiPath = stripMarkdownExtension(relativePath.startsWith('./') ? relativePath.slice(2) : relativePath);
        return {
            path: normalized,
            title,
            wikiPath,
            relativePath,
        };
    });
}

async function loadMarkdownLinkHeadings(currentPayloadPath: string, targetPath: string): Promise<MarkdownLinkHeading[]> {
    if (targetPath === currentPayloadPath && markdownWorkspaceState) {
        return extractMarkdownOutline(markdownWorkspaceState.sourceContent).map((item) => ({ id: item.id, text: item.text }));
    }

    const result = await rpcCallTool?.('read_file', {
        path: targetPath,
        offset: 0,
        length: 5000,
    });
    const text = extractToolText(result) ?? '';
    return extractMarkdownOutline(stripReadStatusLine(text)).map((item) => ({ id: item.id, text: item.text }));
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

function buildOpenInEditorCommand(filePath: string): string | undefined {
    const trimmedPath = filePath.trim();
    if (!trimmedPath || isLikelyUrl(trimmedPath)) {
        return undefined;
    }

    const cachedApp = markdownEditorAppCache.get(trimmedPath);
    if (cachedApp?.appPath && navigator.userAgent.toLowerCase().includes('mac')) {
        return `open -a ${shellQuote(cachedApp.appPath)} ${shellQuote(trimmedPath)}`;
    }

    const userAgent = navigator.userAgent.toLowerCase();
    if (userAgent.includes('win')) {
        const escapedForPowerShell = trimmedPath.replace(/'/g, "''");
        const script = `Start-Process -FilePath '${escapedForPowerShell}'`;
        return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodePowerShellCommand(script)}`;
    }
    if (userAgent.includes('mac')) {
        return `open ${shellQuote(trimmedPath)}`;
    }

    return `xdg-open ${shellQuote(trimmedPath)}`;
}

async function detectDefaultMarkdownEditor(filePath: string): Promise<void> {
    const trimmedPath = filePath.trim();
    if (!trimmedPath || markdownEditorAppCache.has(trimmedPath) || markdownEditorAppPending.has(trimmedPath)) {
        return;
    }

    const userAgent = navigator.userAgent.toLowerCase();
    if (!userAgent.includes('mac')) {
        return;
    }

    markdownEditorAppPending.add(trimmedPath);
    try {
        const detectCommand = `osascript -e ${shellQuote(`set appAlias to default application of (info for POSIX file "${trimmedPath.replace(/"/g, '\\"')}")
return (name of (info for appAlias)) & linefeed & POSIX path of appAlias`)}`;
        const detectResult = await rpcCallTool?.('start_process', {
            command: detectCommand,
            timeout_ms: 12000,
        });
        const text = extractToolText(detectResult) ?? '';
        if (!text || text.toLowerCase().includes('error') || text.toLowerCase().includes('execution')) {
            return;
        }
        const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
        const appName = lines[lines.length - 2]?.replace(/\.app$/i, '') ?? '';
        const appPath = lines[lines.length - 1] ?? '';
        if (appName && appPath.startsWith('/')) {
            markdownEditorAppCache.set(trimmedPath, {
                appName,
                appPath,
            });
            rerenderCurrent?.();
        }
    } catch {
        // Fall back to generic editor label.
    } finally {
        markdownEditorAppPending.delete(trimmedPath);
    }
}

function renderMarkdownEditorAppIcon(): string {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z"/></svg>';
}

function renderRawFallback(source: string): string {
    return `<pre class="code-viewer"><code class="hljs language-text">${escapeHtml(source)}</code></pre>`;
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

function disposeMarkdownWorkspaceHandles(): void {
    markdownEditorHandle?.destroy();
    markdownEditorHandle = undefined;
    markdownTocHandle?.dispose();
    markdownTocHandle = undefined;
}

function getAvailableDisplayModes(): string[] {
    const rawModes = currentHostContext?.availableDisplayModes;
    if (!Array.isArray(rawModes)) {
        return [];
    }

    return rawModes.filter((mode): mode is string => typeof mode === 'string');
}

function getCurrentDisplayMode(): string | null {
    return typeof currentHostContext?.displayMode === 'string'
        ? currentHostContext.displayMode
        : null;
}

function getMarkdownWorkspaceState(payload: RenderPayload): MarkdownWorkspaceState {
    const cleanedContent = stripReadStatusLine(payload.content);

    if (!markdownWorkspaceState || markdownWorkspaceState.filePath !== payload.filePath || markdownWorkspaceState.sourceContent !== cleanedContent) {
        const outline = extractMarkdownOutline(cleanedContent);
        const isPartial = parseReadRange(payload.content)?.isPartial === true;
        const prevInitial = markdownWorkspaceState?.filePath === payload.filePath
            ? markdownWorkspaceState.initialContent
            : undefined;
        markdownWorkspaceState = {
            filePath: payload.filePath,
            initialContent: prevInitial ?? cleanedContent,
            sourceContent: cleanedContent,
            fullDocumentContent: cleanedContent,
            draftContent: cleanedContent,
            mode: isPartial ? 'preview' : 'edit',
            dirty: false,
            activeHeadingId: outline[0]?.id ?? null,
            pendingAnchor: null,
            notice: null,
            error: null,
            saving: false,
            loadingDocument: false,
            editorView: 'markdown',
            editorScrollTop: 0,
            saveIndicator: 'idle',
            fileDeleted: false,
        };
    }

    return markdownWorkspaceState;
}

function updateCurrentPayload(payload: RenderPayload): void {
    currentPayload = payload;
}

function getEffectiveIncomingPayload(payload: RenderPayload): RenderPayload {
    if (!localPayloadOverride) {
        return payload;
    }

    if (localPayloadOverride.filePath !== payload.filePath) {
        localPayloadOverride = undefined;
        return payload;
    }

    const incomingContent = stripReadStatusLine(payload.content);
    const overriddenContent = stripReadStatusLine(localPayloadOverride.content);
    if (incomingContent === overriddenContent) {
        return payload;
    }

    return localPayloadOverride;
}

function buildMarkdownWorkspaceBody(payload: RenderPayload): { html: string; notice?: string } {
    const workspaceState = getMarkdownWorkspaceState(payload);
    const outline = extractMarkdownOutline(workspaceState.sourceContent);
    const isFullscreen = getCurrentDisplayMode() === 'fullscreen';
    const tocHtml = isFullscreen ? renderMarkdownToc(outline, workspaceState.activeHeadingId) : '';
    if (!workspaceState.activeHeadingId && outline.length > 0) {
        workspaceState.activeHeadingId = outline[0].id;
    }

    const messages = [workspaceState.error, workspaceState.notice];

    const notice = messages.find((value): value is string => typeof value === 'string' && value.trim().length > 0);

    if (workspaceState.mode === 'edit') {
        const lineCount = countContentLines(workspaceState.draftContent);
        const wordCount = workspaceState.draftContent.trim().length > 0
            ? workspaceState.draftContent.trim().split(/\s+/).length
            : 0;
        return {
            notice,
            html: `
              <div class="panel-content markdown-content markdown-content--workspace">
                <div class="markdown-workspace markdown-workspace--edit${tocHtml ? ' markdown-workspace--with-toc' : ''}">
                  ${tocHtml}
                  <section class="markdown-workspace-main markdown-workspace-main--editor">
                    ${renderMarkdownEditorShell({
                        content: workspaceState.draftContent,
                        view: workspaceState.editorView,
                    })}
                  </section>
                </div>
              </div>
            `,
        };
    }

    return {
        notice,
        html: `<div class="panel-content markdown-content markdown-content--workspace">${renderMarkdownWorkspacePreview({
            content: workspaceState.sourceContent,
            outline,
            activeHeadingId: workspaceState.activeHeadingId,
            showToc: isFullscreen,
        })}</div>`,
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
        return buildMarkdownWorkspaceBody(payload);
    } catch {
        return {
            notice: 'Markdown renderer failed. Showing raw source instead.',
            html: `<div class="panel-content source-content">${renderRawFallback(cleanedContent)}</div>`
        };
    }
}

function attachCopyHandler(payload: RenderPayload): void {
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

    const setButtonState = (button: HTMLElement, label: string, fallbackLabel: string, revertMs?: number): void => {
        button.setAttribute('title', label);
        button.setAttribute('aria-label', label);
        button.textContent = label;
        if (revertMs) {
            setTimeout(() => {
                button.textContent = fallbackLabel;
                button.setAttribute('title', fallbackLabel);
                button.setAttribute('aria-label', fallbackLabel);
            }, revertMs);
        }
    };

    const setIconButtonState = (button: HTMLElement, label: string, fallbackLabel: string, revertMs?: number): void => {
        button.setAttribute('title', label);
        button.setAttribute('aria-label', label);
        button.dataset.status = label;
        if (revertMs) {
            setTimeout(() => {
                button.setAttribute('title', fallbackLabel);
                button.setAttribute('aria-label', fallbackLabel);
                delete button.dataset.status;
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

    const copyButton = document.getElementById('copy-source');
    copyButton?.addEventListener('click', async () => {
        trackUiEvent?.('copy_clicked', {
            file_type: payload.fileType,
            file_extension: getFileExtensionForAnalytics(payload.filePath)
        });

        const cleanedContent = stripReadStatusLine(payload.content);

        const copied = await copyTextData(cleanedContent);
        setButtonState(copyButton, copied ? 'Copied!' : 'Copy failed', 'Copy', 1500);
    });

    const activeCopyButton = document.getElementById('copy-active-markdown');
    activeCopyButton?.addEventListener('click', async () => {
        const workspaceState = payload.fileType === 'markdown' ? getMarkdownWorkspaceState(payload) : undefined;
        if (!workspaceState) {
            return;
        }

        const source = workspaceState.mode === 'edit'
            ? workspaceState.draftContent
            : stripReadStatusLine(payload.content);
        const textToCopy = workspaceState.editorView === 'raw'
            ? source
            : (getRenderedMarkdownCopyText(source) || source);
        const copied = await copyTextData(textToCopy);
        if (copied) {
            updateSaveStatusDOM('Copied', 'saved');
            window.setTimeout(() => updateSaveStatusDOM('', ''), 1500);
        }
        setIconButtonState(activeCopyButton, copied ? 'Copied!' : 'Copy failed', 'Copy', 1500);
    });
}

function setMarkdownEditorView(payload: RenderPayload, view: MarkdownEditorView): void {
    const workspaceState = getMarkdownWorkspaceState(payload);
    const wrapper = document.querySelector('.panel-content-wrapper') as HTMLElement | null;
    workspaceState.editorScrollTop = wrapper?.scrollTop ?? 0;
    workspaceState.editorView = view;
    workspaceState.notice = null;
    workspaceState.error = null;
    rerenderCurrent?.();
    if (typeof workspaceState.editorScrollTop === 'number') {
        window.requestAnimationFrame(() => {
            const nextWrapper = document.querySelector('.panel-content-wrapper') as HTMLElement | null;
            if (nextWrapper) {
                nextWrapper.scrollTop = workspaceState.editorScrollTop;
            }
        });
    }
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

function attachOpenInEditorHandler(payload: RenderPayload): void {
    const openButton = document.getElementById('open-in-editor') as HTMLButtonElement | null;
    if (!openButton) {
        return;
    }

    const command = buildOpenInEditorCommand(payload.filePath);
    if (!command) {
        openButton.disabled = true;
        return;
    }

    openButton.addEventListener('click', async () => {
        trackUiEvent?.('open_in_editor', {
            file_type: payload.fileType,
            file_extension: getFileExtensionForAnalytics(payload.filePath)
        });

        try {
            await rpcCallTool?.('start_process', {
                command,
                timeout_ms: 12000
            });
        } catch {
            // Keep UI stable if opening editor fails.
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

function findMarkdownHeading(anchor: string): HTMLElement | null {
    const trimmedAnchor = anchor.trim();
    if (!trimmedAnchor) {
        return null;
    }

    return document.getElementById(trimmedAnchor) ?? document.getElementById(slugifyMarkdownHeading(trimmedAnchor));
}

function scrollMarkdownHeadingIntoView(anchor: string): boolean {
    const heading = findMarkdownHeading(anchor);
    if (!heading) {
        return false;
    }

    const scrollParents: HTMLElement[] = [];
    let current: HTMLElement | null = heading.parentElement;
    while (current) {
        const style = window.getComputedStyle(current);
        const overflowY = style.overflowY;
        const isScrollable = (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay')
            && current.scrollHeight > current.clientHeight;
        if (isScrollable) {
            scrollParents.push(current);
        }
        current = current.parentElement;
    }

    heading.scrollIntoView({ block: 'start', inline: 'nearest' });

    for (const parent of scrollParents) {
        const parentRect = parent.getBoundingClientRect();
        const headingRect = heading.getBoundingClientRect();
        const nextTop = Math.max(parent.scrollTop + (headingRect.top - parentRect.top) - 24, 0);
        parent.scrollTop = nextTop;
    }

    const rootScroller = document.scrollingElement as HTMLElement | null;
    if (rootScroller) {
        const rootRectTop = heading.getBoundingClientRect().top;
        const nextRootTop = Math.max(rootScroller.scrollTop + rootRectTop - 24, 0);
        rootScroller.scrollTop = nextRootTop;
    }

    heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
    if (markdownWorkspaceState) {
        markdownWorkspaceState.activeHeadingId = heading.id || slugifyMarkdownHeading(anchor);
    }
    return true;
}

function applyPendingMarkdownAnchor(): void {
    const workspaceState = markdownWorkspaceState;
    const pendingAnchor = workspaceState?.pendingAnchor;
    if (!workspaceState || !pendingAnchor) {
        return;
    }

    workspaceState.pendingAnchor = null;
    if (!scrollMarkdownHeadingIntoView(pendingAnchor)) {
        workspaceState.error = `Heading not found: ${pendingAnchor}`;
        rerenderCurrent?.();
    }
}

async function refreshMarkdownFromDisk(payload: RenderPayload): Promise<void> {
    try {
        const freshResult = await rpcCallTool?.('read_file', { path: payload.filePath });
        const resultText = extractToolText(freshResult) ?? '';

        if (resultText.toLowerCase().includes('error') && (resultText.toLowerCase().includes('not found') || resultText.toLowerCase().includes('no such file') || resultText.toLowerCase().includes('enoent'))) {
            if (markdownWorkspaceState) {
                markdownWorkspaceState.fileDeleted = true;
            }
            updateSaveStatusDOM('File deleted', 'saved');
            // Disable non-applicable buttons via DOM
            const revert = document.getElementById('revert-markdown') as HTMLButtonElement | null;
            if (revert) revert.disabled = true;
            const openFolder = document.getElementById('open-in-folder') as HTMLButtonElement | null;
            if (openFolder) openFolder.disabled = true;
            const openEditor = document.getElementById('open-in-editor') as HTMLButtonElement | null;
            if (openEditor) openEditor.disabled = true;
            return;
        }

        const freshPayload = extractRenderPayload(freshResult) ?? null;
        if (!freshPayload) return;
        const freshContent = stripReadStatusLine(freshPayload.content);
        const currentContent = stripReadStatusLine(payload.content);
        if (freshContent === currentContent) return;

        syncPayload?.(freshPayload);
        localPayloadOverride = freshPayload;
        markdownWorkspaceState = undefined;
        rerenderCurrent?.();
    } catch {
        // Silently fall back to host payload
    }
}

async function readMarkdownPayload(filePath: string, length?: number): Promise<RenderPayload | null> {
    const result = await rpcCallTool?.('read_file', {
        path: filePath,
        ...(typeof length === 'number' ? { offset: 0, length } : {}),
    });
    return extractRenderPayload(result) ?? null;
}

async function loadFullMarkdownDocument(payload: RenderPayload, options: { keepEditMode?: boolean } = {}): Promise<void> {
    const workspaceState = getMarkdownWorkspaceState(payload);
    const range = parseReadRange(payload.content);
    if (!range?.isPartial) {
        if (options.keepEditMode) {
            workspaceState.mode = 'edit';
            workspaceState.editorView = 'markdown';
            workspaceState.notice = null;
            workspaceState.error = null;
            workspaceState.draftContent = workspaceState.sourceContent;
            workspaceState.dirty = false;
            rerenderCurrent?.();
        }
        return;
    }

    workspaceState.loadingDocument = true;
    workspaceState.notice = 'Loading full document…';
    workspaceState.error = null;
    rerenderCurrent?.();

    try {
        const nextPayload = await readMarkdownPayload(payload.filePath, range.totalLines);
        if (!nextPayload) {
            workspaceState.error = 'Failed to load the full document.';
            workspaceState.notice = null;
            workspaceState.loadingDocument = false;
            rerenderCurrent?.();
            return;
        }

        syncPayload?.(nextPayload);
        const nextState = getMarkdownWorkspaceState(nextPayload);
        nextState.loadingDocument = false;
        nextState.notice = null;
        nextState.error = null;
        if (options.keepEditMode) {
            nextState.mode = 'edit';
            nextState.editorView = 'markdown';
            nextState.draftContent = nextState.sourceContent;
            nextState.dirty = false;
            rerenderCurrent?.();
        }
    } catch {
        workspaceState.loadingDocument = false;
        workspaceState.notice = null;
        workspaceState.error = 'Failed to load the full document.';
        rerenderCurrent?.();
    }
}

async function navigateMarkdownLink(payload: RenderPayload, href: string): Promise<void> {
    const workspaceState = getMarkdownWorkspaceState(payload);
    if (workspaceState.mode === 'edit' && workspaceState.dirty) {
        const shouldDiscard = window.confirm('Discard unsaved changes and follow this link?');
        if (!shouldDiscard) {
            return;
        }
    }

    const resolvedLink = resolveMarkdownLink(payload.filePath, href);
    workspaceState.notice = null;
    workspaceState.error = null;

    if (resolvedLink.kind === 'external' && resolvedLink.url) {
        const opened = await openExternalLink?.(resolvedLink.url);
        if (!opened && markdownWorkspaceState) {
            markdownWorkspaceState.error = 'The host blocked that external link.';
            rerenderCurrent?.();
        }
        return;
    }

    if (resolvedLink.kind === 'anchor' && resolvedLink.anchor) {
        if (!scrollMarkdownHeadingIntoView(resolvedLink.anchor) && markdownWorkspaceState) {
            markdownWorkspaceState.error = `Heading not found: ${resolvedLink.anchor}`;
            rerenderCurrent?.();
        }
        return;
    }

    if (resolvedLink.kind === 'file' && resolvedLink.targetPath) {
        // Delegate file navigation to the host so it can open the file in its own
        // viewer (e.g. dc-app file preview modal with back/forward navigation).
        // Fall back to in-app reading if the host doesn't handle the link.
        const hostHandled = await openExternalLink?.(resolvedLink.targetPath);
        if (hostHandled) {
            return;
        }

        const nextPayload = await readMarkdownPayload(resolvedLink.targetPath);
        if (!nextPayload) {
            if (markdownWorkspaceState) {
                markdownWorkspaceState.error = `Unable to open ${resolvedLink.targetPath}.`;
                rerenderCurrent?.();
            }
            return;
        }

        syncPayload?.(nextPayload);
        const nextState = getMarkdownWorkspaceState(nextPayload);
        nextState.pendingAnchor = resolvedLink.anchor ?? null;
        nextState.error = null;
        nextState.notice = null;
        rerenderCurrent?.();
    }
}

async function requestMarkdownEditMode(payload: RenderPayload): Promise<void> {
    const workspaceState = getMarkdownWorkspaceState(payload);

    workspaceState.error = null;
    workspaceState.notice = null;

    if (shouldAutoLoadMarkdownOnEnterFullscreen(payload.content)) {
        await loadFullMarkdownDocument(payload, { keepEditMode: true });
        return;
    }

    const editAvailability = getMarkdownEditAvailability({
        content: payload.content,
    });
    if (!editAvailability.canEdit) {
        workspaceState.error = editAvailability.reason;
        rerenderCurrent?.();
        return;
    }

    workspaceState.mode = 'edit';
    workspaceState.draftContent = workspaceState.fullDocumentContent;
    workspaceState.dirty = false;
    workspaceState.editorView = 'markdown';
    isExpanded = true;
    rerenderCurrent?.();
}

async function requestMarkdownFullscreen(): Promise<boolean> {
    const fullscreenAvailability = getMarkdownFullscreenAvailability({
        availableDisplayModes: getAvailableDisplayModes(),
    });
    if (!fullscreenAvailability.canFullscreen) {
        return false;
    }
    const nextMode = await requestDisplayMode?.('fullscreen');
    return nextMode === 'fullscreen';
}

function revertMarkdownEditing(): void {
    const ws = markdownWorkspaceState;
    if (!ws) return;
    ws.draftContent = ws.initialContent;
    ws.sourceContent = ws.initialContent;
    ws.dirty = ws.initialContent !== ws.fullDocumentContent;
    ws.error = null;
    ws.notice = null;
    // Update currentPayload to match so re-render doesn't recreate state
    if (currentPayload) {
        currentPayload = { ...currentPayload, content: ws.initialContent };
    }
    rerenderCurrent?.();
    updateSaveStatusDOM('Reverted', 'saved');
    window.setTimeout(() => updateSaveStatusDOM('', ''), 1500);
}

function cancelMarkdownEditing(payload: RenderPayload): void {
    const workspaceState = getMarkdownWorkspaceState(payload);
    if (workspaceState.dirty) {
        const shouldDiscard = window.confirm('Discard unsaved changes?');
        if (!shouldDiscard) {
            return;
        }
    }

    workspaceState.mode = 'preview';
    workspaceState.dirty = false;
    workspaceState.draftContent = workspaceState.fullDocumentContent;
    workspaceState.notice = null;
    workspaceState.error = null;
    rerenderCurrent?.();
}

interface DiffHunk {
    oldStart: number;
    oldEnd: number;
    newStart: number;
    newEnd: number;
}

function computeDiffHunks(oldLines: string[], newLines: string[]): DiffHunk[] {
    const m = oldLines.length;
    const n = newLines.length;

    // For very large files, treat as single change
    if (m * n > 1_000_000) {
        return [{ oldStart: 0, oldEnd: m, newStart: 0, newEnd: n }];
    }

    // LCS via DP
    const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[]);
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = oldLines[i - 1] === newLines[j - 1]
                ? dp[i - 1][j - 1] + 1
                : Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
    }

    // Trace back to find matching line pairs
    const matches: Array<[number, number]> = [];
    let i = m;
    let j = n;
    while (i > 0 && j > 0) {
        if (oldLines[i - 1] === newLines[j - 1]) {
            matches.unshift([i - 1, j - 1]);
            i--;
            j--;
        } else if (dp[i - 1][j] >= dp[i][j - 1]) {
            i--;
        } else {
            j--;
        }
    }

    // Gaps between matches are change hunks
    const hunks: DiffHunk[] = [];
    let prevOld = 0;
    let prevNew = 0;
    for (const [oi, ni] of matches) {
        if (oi > prevOld || ni > prevNew) {
            hunks.push({ oldStart: prevOld, oldEnd: oi, newStart: prevNew, newEnd: ni });
        }
        prevOld = oi + 1;
        prevNew = ni + 1;
    }
    if (prevOld < m || prevNew < n) {
        hunks.push({ oldStart: prevOld, oldEnd: m, newStart: prevNew, newEnd: n });
    }

    return hunks;
}

function mergeCloseHunks(hunks: DiffHunk[], minGap: number): DiffHunk[] {
    if (hunks.length <= 1) return hunks;
    const merged: DiffHunk[] = [{ ...hunks[0] }];
    for (let i = 1; i < hunks.length; i++) {
        const prev = merged[merged.length - 1];
        const curr = hunks[i];
        if (curr.oldStart - prev.oldEnd < minGap) {
            prev.oldEnd = curr.oldEnd;
            prev.newEnd = curr.newEnd;
        } else {
            merged.push({ ...curr });
        }
    }
    return merged;
}

function computeEditBlocks(oldText: string, newText: string): Array<{ old_string: string; new_string: string }> {
    if (oldText === newText) return [];

    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    const hunks = computeDiffHunks(oldLines, newLines);
    if (hunks.length === 0) return [];

    const CONTEXT = 3;
    const merged = mergeCloseHunks(hunks, CONTEXT * 2 + 1);

    // If changes cover most of the file, single full edit
    const totalChanged = merged.reduce((sum, h) => sum + (h.oldEnd - h.oldStart), 0);
    if (totalChanged > oldLines.length * 0.7) {
        return [{ old_string: oldText, new_string: newText }];
    }

    return merged.map((hunk) => {
        const ctxBefore = Math.max(0, hunk.oldStart - CONTEXT);
        const ctxAfter = Math.min(oldLines.length, hunk.oldEnd + CONTEXT);

        const oldBlock = oldLines.slice(ctxBefore, ctxAfter).join('\n');
        const newBlock = [
            ...oldLines.slice(ctxBefore, hunk.oldStart),
            ...newLines.slice(hunk.newStart, hunk.newEnd),
            ...oldLines.slice(hunk.oldEnd, ctxAfter),
        ].join('\n');

        return { old_string: oldBlock, new_string: newBlock };
    }).filter((block) => block.old_string !== block.new_string);
}

function updateSaveStatusDOM(label: string, statusClass: string): void {
    const existing = document.querySelector('.panel-save-status') as HTMLElement | null;
    if (label) {
        if (existing) {
            existing.textContent = label;
            existing.className = `panel-save-status panel-save-status--${statusClass}`;
        } else {
            const actions = document.querySelector('.panel-topbar-actions') as HTMLElement | null;
            if (actions) {
                const span = document.createElement('span');
                span.className = `panel-save-status panel-save-status--${statusClass}`;
                span.textContent = label;
                actions.prepend(span);
            }
        }
    } else if (existing) {
        existing.remove();
    }
}

async function saveMarkdownDocument(): Promise<void> {
    const ws = markdownWorkspaceState;
    if (!ws || ws.saving || !ws.dirty || ws.fileDeleted) {
        return;
    }
    ws.saving = true;
    ws.saveIndicator = 'saving';
    ws.error = null;
    ws.notice = null;

    try {
        const blocks = computeEditBlocks(ws.fullDocumentContent, ws.draftContent);
        if (blocks.length === 0) {
            ws.saving = false;
            ws.saveIndicator = 'idle';
            ws.dirty = false;
            return;
        }

        for (const block of blocks) {
            await rpcCallTool?.('edit_block', {
                file_path: ws.filePath,
                old_string: block.old_string,
                new_string: block.new_string,
                expected_replacements: 1,
            });
        }

        ws.fullDocumentContent = ws.draftContent;
        ws.sourceContent = ws.draftContent;
        ws.dirty = false;
        ws.saving = false;
        ws.saveIndicator = 'saved';

        // Update payloads so re-renders and refreshes use saved content (no re-render here)
        if (currentPayload) {
            const savedPayload: RenderPayload = { ...currentPayload, content: ws.draftContent };
            localPayloadOverride = savedPayload;
            currentPayload = savedPayload;
            persistPayload?.(savedPayload);
        }

        updateSaveStatusDOM('Saved', 'saved');
        const revert = document.getElementById('revert-markdown') as HTMLButtonElement | null;
        if (revert) revert.disabled = ws.draftContent === ws.initialContent;
        window.setTimeout(() => {
            if (markdownWorkspaceState?.filePath === ws.filePath && !markdownWorkspaceState.dirty && !markdownWorkspaceState.saving) {
                markdownWorkspaceState.saveIndicator = 'idle';
                updateSaveStatusDOM('', '');
            }
        }, 1800);
    } catch {
        ws.saving = false;
        ws.saveIndicator = 'idle';
        updateSaveStatusDOM('Save failed', 'saving');
        window.setTimeout(() => updateSaveStatusDOM('', ''), 3000);
    }
}

function maybeAutosaveMarkdownDocument(): void {
    if (!markdownWorkspaceState?.dirty || markdownWorkspaceState.saving) {
        return;
    }
    void saveMarkdownDocument();
}

function attachMarkdownWorkspaceHandlers(payload: RenderPayload): void {
    if (payload.fileType !== 'markdown') {
        return;
    }

    const workspaceState = getMarkdownWorkspaceState(payload);
    const wrapper = document.querySelector('.panel-content-wrapper') as HTMLElement | null;
    const markdownDoc = document.querySelector('.markdown-doc') as HTMLElement | null;
    const outline = extractMarkdownOutline(workspaceState.sourceContent);


    if (workspaceState.mode === 'edit') {
        const editorRoot = document.getElementById('markdown-editor-root');
        if (editorRoot) {
            markdownEditorHandle = mountMarkdownEditor({
                target: editorRoot,
                value: workspaceState.draftContent,
                view: workspaceState.editorView,
                initialScrollTop: workspaceState.editorScrollTop,
                currentFilePath: payload.filePath,
                searchLinks: (query) => searchMarkdownLinkTargets(payload.filePath, query),
                loadHeadings: (targetPath) => loadMarkdownLinkHeadings(payload.filePath, targetPath),
                onChange: (value) => {
                    workspaceState.draftContent = value;
                    workspaceState.dirty = value !== workspaceState.fullDocumentContent;
                    if (workspaceState.dirty && workspaceState.saveIndicator === 'saved') {
                        workspaceState.saveIndicator = 'idle';
                    }
                    const revert = document.getElementById('revert-markdown') as HTMLButtonElement | null;
                    if (revert) {
                        revert.disabled = value === workspaceState.initialContent;
                    }
                },
                onBlur: () => {
                    maybeAutosaveMarkdownDocument();
                },
            });
            markdownEditorHandle.focus();
        }

        const revertButton = document.getElementById('revert-markdown') as HTMLButtonElement | null;
        revertButton?.addEventListener('click', () => {
            revertMarkdownEditing();
        });

        const expandButton = document.getElementById('expand-fullscreen') as HTMLButtonElement | null;
        expandButton?.addEventListener('click', () => {
            void requestMarkdownFullscreen();
        });

        const rawModeButton = document.getElementById('markdown-mode-raw') as HTMLButtonElement | null;
        rawModeButton?.addEventListener('click', () => {
            setMarkdownEditorView(payload, 'raw');
        });

        const previewModeButton = document.getElementById('markdown-mode-markdown') as HTMLButtonElement | null;
        previewModeButton?.addEventListener('click', () => {
            setMarkdownEditorView(payload, 'markdown');
        });
    }

    if (markdownDoc) {
        markdownDoc.addEventListener('click', (event) => {
            const target = event.target as HTMLElement | null;
            const link = target?.closest<HTMLAnchorElement>('a[href]');
            const href = link?.getAttribute('href');
            if (!href) {
                return;
            }

            if (workspaceState.mode === 'edit' && workspaceState.editorView === 'markdown') {
                const mouseEvent = event as MouseEvent;
                if (!(mouseEvent.metaKey || mouseEvent.ctrlKey)) {
                    return;
                }
            }

            event.preventDefault();
            void navigateMarkdownLink(payload, href);
        });
    }

    const tocShell = document.querySelector('.markdown-toc-shell') as HTMLElement | null;
    if (tocShell && wrapper) {
        markdownTocHandle = attachMarkdownToc({
            shell: tocShell,
            outline,
            scrollContainer: wrapper,
            onSelect: (headingId) => {
                const selectedHeading = outline.find((item) => item.id === headingId);
                if (workspaceState.mode === 'edit') {
                    if (selectedHeading) {
                        markdownEditorHandle?.revealLine(selectedHeading.line, selectedHeading.id);
                        workspaceState.activeHeadingId = selectedHeading.id;
                    }
                    return;
                }

                scrollMarkdownHeadingIntoView(headingId);
            },
        }) ?? undefined;
    }

    window.setTimeout(() => {
        applyPendingMarkdownAnchor();
    }, 0);
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
    if (payload.fileType === 'markdown' && getMarkdownWorkspaceState(payload).mode === 'edit') {
        if (selectionAbortController) {
            selectionAbortController.abort();
            selectionAbortController = null;
        }
        return;
    }

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
        ${renderCompactRow({ label: message, variant: 'status', interactive: false })}
      </main>
    `;
    document.body.classList.add('dc-ready');
}

function renderLoadingState(container: HTMLElement): void {
    container.innerHTML = `
      <main class="shell">
        ${renderCompactRow({ label: 'Preparing preview…', variant: 'loading', interactive: false })}
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
    currentHtmlMode = htmlMode;
    shellController?.dispose();
    shellController = undefined;
    disposeMarkdownWorkspaceHandles();

    if (!payload) {
        currentPayload = undefined;
        renderStatusState(container, 'No preview available for this response.');
        onRender?.();
        return;
    }

    updateCurrentPayload(payload);

    if (payload.fileType !== 'markdown') {
        markdownWorkspaceState = undefined;
    }

    const markdownWorkspace = payload.fileType === 'markdown' ? getMarkdownWorkspaceState(payload) : undefined;
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
    let footerLabel = range?.isPartial
        ? `${escapeHtml(fileTypeLabel)} • LINES ${range.fromLine}–${range.toLine} OF ${range.totalLines}`
        : `${escapeHtml(fileTypeLabel)} • ${lineCount} LINE${lineCount !== 1 ? 'S' : ''}`;
    const markdownWordCount = payload.fileType === 'markdown'
        ? (stripReadStatusLine(markdownWorkspace?.mode === 'edit' ? markdownWorkspace.draftContent : payload.content).trim().split(/\s+/).filter(Boolean).length)
        : 0;
    const markdownLineCount = payload.fileType === 'markdown'
        ? countContentLines(stripReadStatusLine(markdownWorkspace?.mode === 'edit' ? markdownWorkspace.draftContent : payload.content))
        : lineCount;

    if (markdownWorkspace?.mode === 'edit') {
        footerLabel = `${escapeHtml(fileTypeLabel)} • EDIT MODE • ${markdownLineCount} LINES • ${markdownWordCount} WORDS`;
    }

    const htmlToggle = payload.fileType === 'html'
        ? `<button class="panel-action" id="toggle-html-mode">${htmlMode === 'rendered' ? 'Source' : 'Rendered'}</button>`
        : '';

    const copyIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
    const folderIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
    const undoIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 1 1 0 10h-1"/></svg>`;
    const expandIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;
    const isFullscreen = getCurrentDisplayMode() === 'fullscreen';
    const canGoFullscreen = !isFullscreen && getMarkdownFullscreenAvailability({ availableDisplayModes: getAvailableDisplayModes() }).canFullscreen;
    let markdownActions = '';
    if (payload.fileType === 'markdown' && markdownWorkspace) {
        const saveStatusLabel = markdownWorkspace.saveIndicator === 'saved'
            ? 'Saved'
            : '';
        if (markdownWorkspace.mode === 'edit') {
            const deleted = markdownWorkspace.fileDeleted;
            const revertDisabled = deleted || markdownWorkspace.loadingDocument || markdownWorkspace.draftContent === markdownWorkspace.initialContent;
            if (isFullscreen) {
                markdownActions = `
                  ${deleted ? '<span class="panel-save-status panel-save-status--saved">File deleted</span>' : ''}
                  ${!deleted && saveStatusLabel ? `<span class="panel-save-status panel-save-status--${markdownWorkspace.saving ? 'saving' : 'saved'}">${saveStatusLabel}</span>` : ''}
                  ${renderMarkdownModeToggle(markdownWorkspace.editorView)}
                  ${renderMarkdownCopyButton()}
                  <button class="panel-action" id="revert-markdown" ${revertDisabled ? 'disabled' : ''}>${undoIcon} Undo</button>
                `;
            } else {
                markdownActions = `
                  ${deleted ? '<span class="panel-save-status panel-save-status--saved">File deleted</span>' : ''}
                  ${!deleted && saveStatusLabel ? `<span class="panel-save-status panel-save-status--${markdownWorkspace.saving ? 'saving' : 'saved'}">${saveStatusLabel}</span>` : ''}
                  ${canGoFullscreen ? `<button class="panel-action" id="expand-fullscreen" title="Expand" aria-label="Expand">${expandIcon}</button>` : ''}
                  <button class="panel-action" id="copy-active-markdown" title="Copy" aria-label="Copy">${copyIcon}</button>
                  <button class="panel-action" id="revert-markdown" title="Undo" aria-label="Undo" ${revertDisabled ? 'disabled' : ''}>${undoIcon}</button>
                `;
            }
        }
    }

    const editorIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
    const defaultMarkdownEditor = payload.fileType === 'markdown' ? markdownEditorAppCache.get(payload.filePath) : undefined;
    if (payload.fileType === 'markdown' && !defaultMarkdownEditor) {
        void detectDefaultMarkdownEditor(payload.filePath);
    }
    
    // Content-area banners for missing lines
    const hasMissingBefore = range?.isPartial && range.fromLine > 1;
    const hasMissingAfter = range?.isPartial && range.toLine < range.totalLines && (range.totalLines - range.toLine) > 1;
    const loadBeforeBanner = hasMissingBefore
        ? `<button class="load-lines-banner" id="load-before">↑ Load lines 1–${range!.fromLine - 1}</button>`
        : '';
    const loadAfterBanner = hasMissingAfter
        ? `<button class="load-lines-banner" id="load-after">↓ Load lines ${range!.toLine + 1}–${range!.totalLines}</button>`
        : '';

    const effectiveExpanded = isExpanded || getCurrentDisplayMode() === 'fullscreen';

    container.innerHTML = `
      <main id="tool-shell" class="shell tool-shell ${effectiveExpanded ? 'expanded' : 'collapsed'}${hideSummaryRow ? ' host-framed' : ''}${getCurrentDisplayMode() === 'fullscreen' ? ' fullscreen' : ''}">
        ${getCurrentDisplayMode() === 'fullscreen' ? '' : renderCompactRow({ id: 'compact-toggle', label: compactLabel, filename: payload.fileName, variant: 'ready', expandable: true, expanded: isExpanded, interactive: true })}
        <section class="panel">
          <div class="panel-topbar">
            ${hideSummaryRow ? '' : `<span class="panel-breadcrumb" title="${escapeHtml(payload.filePath)}">${breadcrumb}</span>`}
            <span class="panel-topbar-actions">
               ${markdownActions}
               ${htmlToggle}
                ${canOpenInFolder && payload.fileType === 'markdown' && markdownWorkspace?.mode === 'edit' && isFullscreen ? `<button class="panel-action" id="open-in-editor" ${markdownWorkspace?.fileDeleted ? 'disabled' : ''}>${renderMarkdownEditorAppIcon()} Open in ${escapeHtml(defaultMarkdownEditor?.appName ?? 'editor')}</button>` : ''}
                ${canOpenInFolder && payload.fileType === 'markdown' && markdownWorkspace?.mode === 'edit' && !isFullscreen ? `<button class="panel-action" id="open-in-folder" title="Open in folder" aria-label="Open in folder" ${markdownWorkspace?.fileDeleted ? 'disabled' : ''}>${folderIcon}</button>` : ''}
                ${canOpenInFolder && !(payload.fileType === 'markdown' && markdownWorkspace?.mode === 'edit') ? `<button class="panel-action" id="open-in-folder">${folderIcon} Open in folder</button>` : ''}
                ${canCopy && supportsPreview && payload.fileType !== 'markdown' ? `<button class="panel-action" id="copy-source" title="Copy source" aria-label="Copy source">${copyIcon} Copy</button>` : ''}
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
    attachOpenInEditorHandler(payload);
    attachLoadAllHandler(container, payload, htmlMode);
    attachMarkdownWorkspaceHandlers(payload);
    attachTextSelectionHandler(payload);

    const compactRow = document.getElementById('compact-toggle') as HTMLElement | null;

    shellController = createCompactRowShellController({
        shell: document.getElementById('tool-shell'),
        compactRow,
        initialExpanded: effectiveExpanded,
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
    if (!previewShownFired) {
        previewShownFired = true;
        trackUiEvent?.('preview_shown', {
            file_type: payload.fileType,
            file_extension: fileExtension
        });
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

    const chrome: UiChromeState = {
        expanded: isExpanded,
        hideSummaryRow,
    };
    const syncChromeState = (): void => {
        isExpanded = chrome.expanded;
        hideSummaryRow = chrome.hideSummaryRow;
    };

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
    const syncFromPersistedWidgetState = (): void => {
        const persistedPayload = widgetState.read();
        if (!persistedPayload) {
            return;
        }

        if (
            currentPayload
            && currentPayload.filePath === persistedPayload.filePath
            && stripReadStatusLine(currentPayload.content) === stripReadStatusLine(persistedPayload.content)
        ) {
            return;
        }

        renderAndSync(persistedPayload);
    };
    syncPayload = renderAndSync;
    persistPayload = (payload: RenderPayload) => { widgetState.write(payload); };
    rerenderCurrent = () => {
        renderApp(container, currentPayload, currentHtmlMode, isExpanded);
    };

    let initialStateResolved = false;
    const resolveInitialState = (payload?: RenderPayload, message?: string): void => {
        if (initialStateResolved) {
            return;
        }
        initialStateResolved = true;
        if (payload) {
            renderAndSync(payload);
            if (payload.fileType === 'markdown' && getCurrentDisplayMode() === 'fullscreen') {
                void requestMarkdownEditMode(payload);
            }
            // Re-read markdown from disk to pick up any saves from a previous session
            if (payload.fileType === 'markdown') {
                void refreshMarkdownFromDisk(payload);
            }
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

    openExternalLink = async (url: string): Promise<boolean> => {
        const result = await app.openLink({ url });
        return result.isError !== true;
    };

    requestDisplayMode = async (mode: 'inline' | 'fullscreen'): Promise<string | null> => {
        const result = await app.requestDisplayMode({ mode });
        return typeof result.mode === 'string' ? result.mode : null;
    };

    trackUiEvent = createUiEventTracker(
        (name, args) => app.callServerTool({ name, arguments: args }),
        {
            component: 'file_preview',
            baseParams: { tool_name: 'read_file' },
        }
    );

    // Register ALL handlers BEFORE connect
    app.onteardown = async () => {
        shellController?.dispose();
        disposeMarkdownWorkspaceHandles();
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
                const effectivePayload = getEffectiveIncomingPayload(payload);
                renderLoadingState(container);
                onRender?.();
                window.setTimeout(() => resolveInitialState(effectivePayload), 120);
                return;
            }
            if (message) {
                resolveInitialState(undefined, message);
            }
            return;
        }
        if (payload) {
            const effectivePayload = getEffectiveIncomingPayload(payload);
            renderAndSync(effectivePayload);
        } else if (message) {
            renderStatusState(container, message);
            onRender?.();
        }
    };

    app.ontoolcancelled = (params) => {
        resolveInitialState(undefined, params.reason ?? 'Tool was cancelled.');
    };

    // Connect to the host (defaults to window.parent via PostMessageTransport)
    void connectWithSharedHostContext({
        app,
        chrome,
        onContextApplied: () => {
            const previousDisplayMode = getCurrentDisplayMode();
            syncChromeState();
            currentHostContext = app.getHostContext() as Record<string, unknown> | undefined;
            const nextDisplayMode = getCurrentDisplayMode();
            if (
                previousDisplayMode === 'fullscreen'
                && nextDisplayMode === 'inline'
                && currentPayload?.fileType === 'markdown'
            ) {
                isExpanded = true;
                chrome.expanded = true;
                if (markdownWorkspaceState) {
                    markdownWorkspaceState.notice = null;
                    markdownWorkspaceState.editorView = 'markdown';
                }
            }
            if (initialStateResolved) {
                rerenderCurrent?.();
            }
        },
        onConnected: () => {
            currentHostContext = app.getHostContext() as Record<string, unknown> | undefined;
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
        },
    }).catch(() => {
        renderStatusState(container, 'Failed to connect to host.');
        onRender?.();
    });

    const handleVisibilitySync = (): void => {
        if (document.visibilityState === 'visible') {
            syncFromPersistedWidgetState();
        }
    };

    const handleFocusSync = (): void => {
        syncFromPersistedWidgetState();
    };

    document.addEventListener('visibilitychange', handleVisibilitySync);
    window.addEventListener('focus', handleFocusSync);

    window.addEventListener('beforeunload', () => {
        shellController?.dispose();
        disposeMarkdownWorkspaceHandles();
        document.removeEventListener('visibilitychange', handleVisibilitySync);
        window.removeEventListener('focus', handleFocusSync);
    }, { once: true });
}
