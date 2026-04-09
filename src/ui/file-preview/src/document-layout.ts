import { renderCompactRow } from '../../shared/compact-row.js';
import { escapeHtml } from '../../shared/escape-html.js';
import { parseReadRange, stripReadStatusLine } from './document-workspace.js';
import type { FileTypeCapabilities, MarkdownWorkspaceState, RenderBodyResult, RenderPayload } from './model.js';
import { renderMarkdownCopyButton, renderMarkdownModeToggle } from './markdown/editor.js';
import { buildBreadcrumb, countContentLines } from './payload-utils.js';

function renderCopyIcon(): string {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
}

function renderFolderIcon(): string {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
}

function renderUndoIcon(): string {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 1 1 0 10h-1"/></svg>';
}

function renderExpandIcon(): string {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
}

function renderMarkdownSaveStatus(workspace: MarkdownWorkspaceState): string {
    if (workspace.fileDeleted) {
        return '<span class="panel-save-status panel-save-status--saved">File deleted</span>';
    }

    if (workspace.saveIndicator !== 'saved') {
        return '';
    }

    const variant = workspace.saving ? 'saving' : 'saved';
    return `<span class="panel-save-status panel-save-status--${variant}">Saved</span>`;
}

export function buildDocumentLayout(options: {
    payload: RenderPayload;
    body: RenderBodyResult;
    capabilities: FileTypeCapabilities;
    fileExtension: string;
    htmlMode: 'rendered' | 'source';
    currentDisplayMode: string | null;
    isExpanded: boolean;
    hideSummaryRow: boolean;
    markdownWorkspace?: MarkdownWorkspaceState;
    canGoFullscreen: boolean;
    isMarkdownUndoAvailable: boolean;
    defaultMarkdownEditorName?: string;
    markdownEditorAppIcon: string;
    hasDirectoryBackButton: boolean;
}): { html: string; effectiveExpanded: boolean } {
    const range = parseReadRange(options.payload.content);
    const notice = options.body.notice ? `<div class="notice">${options.body.notice}</div>` : '';
    const breadcrumb = buildBreadcrumb(options.payload.filePath);
    const lineCount = range ? range.toLine - range.fromLine + 1 : countContentLines(options.payload.content);
    const fileTypeLabel = options.payload.fileType === 'markdown' ? 'MARKDOWN'
        : options.payload.fileType === 'html' ? 'HTML'
        : options.payload.fileType === 'image' ? 'IMAGE'
        : options.payload.fileType === 'directory' ? 'DIRECTORY'
        : options.fileExtension !== 'none' ? options.fileExtension.toUpperCase()
        : 'TEXT';

    const compactLabel = range?.isPartial
        ? `View lines ${range.fromLine}–${range.toLine}`
        : options.payload.fileType === 'directory' ? 'View directory'
        : 'View file';
    let footerLabel = range?.isPartial
        ? `${fileTypeLabel} • LINES ${range.fromLine}–${range.toLine} OF ${range.totalLines}`
        : `${fileTypeLabel} • ${lineCount} LINE${lineCount !== 1 ? 'S' : ''}`;

    if (options.markdownWorkspace?.mode === 'edit') {
        const source = stripReadStatusLine(options.markdownWorkspace.draftContent);
        const markdownWordCount = source.trim().split(/\s+/).filter(Boolean).length;
        const markdownLineCount = countContentLines(source);
        footerLabel = `${fileTypeLabel} • EDIT MODE • ${markdownLineCount} LINES • ${markdownWordCount} WORDS`;
    }

    const isFullscreen = options.currentDisplayMode === 'fullscreen';
    const htmlToggle = options.payload.fileType === 'html'
        ? `<button class="panel-action" id="toggle-html-mode">${options.htmlMode === 'rendered' ? 'Source' : 'Rendered'}</button>`
        : '';
    const backButton = options.hasDirectoryBackButton && options.payload.fileType !== 'directory'
        ? '<button class="panel-action dir-back-btn" id="dir-back" title="Back to directory">← Back</button>'
        : '';

    const isMarkdown = options.payload.fileType === 'markdown';
    const isMarkdownEdit = isMarkdown && options.markdownWorkspace?.mode === 'edit';
    const revertDisabled = isMarkdownEdit && (options.markdownWorkspace!.fileDeleted || options.markdownWorkspace!.loadingDocument || !options.isMarkdownUndoAvailable);
    const fileDeleted = isMarkdownEdit && options.markdownWorkspace!.fileDeleted;

    const hasMissingBefore = range?.isPartial && range.fromLine > 1;
    const hasMissingAfter = range?.isPartial && range.toLine < range.totalLines && (range.totalLines - range.toLine) > 1;
    const loadBeforeBanner = hasMissingBefore
        ? `<button class="load-lines-banner" id="load-before">↑ Load lines 1–${range!.fromLine - 1}</button>`
        : '';
    const loadAfterBanner = hasMissingAfter
        ? `<button class="load-lines-banner" id="load-after">↓ Load lines ${range!.toLine + 1}–${range!.totalLines}</button>`
        : '';

    const effectiveExpanded = options.isExpanded || isFullscreen;
    const canOpenInFolder = options.capabilities.canOpenInFolder;
    const canCopy = options.capabilities.canCopy;

    return {
        effectiveExpanded,
        html: `
          <main id="tool-shell" class="shell tool-shell ${effectiveExpanded ? 'expanded' : 'collapsed'}${options.hideSummaryRow ? ' host-framed' : ''}${isFullscreen ? ' fullscreen' : ''}">
            ${isFullscreen ? '' : renderCompactRow({ id: 'compact-toggle', label: compactLabel, filename: options.payload.fileName, variant: 'ready', expandable: true, expanded: options.isExpanded, interactive: true })}
            <section class="panel">
              <div class="panel-topbar">
                ${backButton}
                ${options.hideSummaryRow ? '' : `<span class="panel-breadcrumb" title="${escapeHtml(options.payload.filePath)}">${breadcrumb}</span>`}
                <span class="panel-topbar-actions">
                    ${isMarkdownEdit ? renderMarkdownSaveStatus(options.markdownWorkspace!) : ''}
                    ${htmlToggle}
                    ${isMarkdownEdit && isFullscreen ? renderMarkdownModeToggle(options.markdownWorkspace!.editorView) : ''}
                    ${isMarkdown && !isFullscreen && options.canGoFullscreen ? `<button class="panel-action" id="expand-fullscreen" title="Expand" aria-label="Expand">${renderExpandIcon()}</button>` : ''}
                    ${isMarkdownEdit ? `<button class="panel-action" id="revert-markdown" ${isFullscreen ? '' : 'title="Undo" aria-label="Undo" '}${revertDisabled ? 'disabled' : ''}>${renderUndoIcon()}${isFullscreen ? ' Undo' : ''}</button>` : ''}
                    ${isMarkdownEdit && isFullscreen ? renderMarkdownCopyButton() : ''}
                    ${isMarkdown && !isFullscreen ? `<button class="panel-action" id="copy-active-markdown" title="Copy" aria-label="Copy">${renderCopyIcon()}</button>` : ''}
                    ${canCopy && options.capabilities.supportsPreview && !isMarkdown ? `<button class="panel-action" id="copy-source" title="Copy source" aria-label="Copy source">${renderCopyIcon()}</button>` : ''}
                    ${canOpenInFolder && isMarkdownEdit && isFullscreen ? `<button class="panel-action" id="open-in-editor" ${fileDeleted ? 'disabled' : ''}>${options.markdownEditorAppIcon} Open in ${escapeHtml(options.defaultMarkdownEditorName ?? 'editor')}</button>` : ''}
                    ${canOpenInFolder && !(isMarkdownEdit && isFullscreen) ? `<button class="panel-action" id="open-in-folder" title="Open in folder" aria-label="Open in folder" ${isMarkdownEdit && fileDeleted ? 'disabled' : ''}>${renderFolderIcon()}</button>` : ''}
                </span>
              </div>
              ${notice}
              <div class="panel-content-wrapper">
                ${loadBeforeBanner}
                ${options.body.html}
                ${loadAfterBanner}
              </div>
              <div class="panel-footer">
                <span>${footerLabel}</span>
              </div>
            </section>
          </main>
        `,
    };
}
