/**
 * Toolbar component for preview controls (view mode, metadata, actions). It isolates UI control rendering and event plumbing from core preview orchestration.
 */
import type { FilePreviewStructuredContent } from '../../../../types.js';
import type { HtmlPreviewMode } from '../types.js';
import { renderToolHeader } from '../../../shared/tool-header.js';

function inferFilePill(payload: FilePreviewStructuredContent): { label: string; className: string } {
    if (payload.fileType === 'markdown') {
        return { label: 'MD', className: 'file-pill--md' };
    }
    if (payload.fileType === 'html') {
        return { label: 'HTML', className: 'file-pill--html' };
    }

    const extensionMatch = payload.filePath.toLowerCase().match(/\.([a-z0-9]+)$/);
    const extension = extensionMatch ? extensionMatch[1] : 'txt';

    if (extension === 'json') {
        return { label: 'JSON', className: 'file-pill--json' };
    }

    return { label: extension.slice(0, 4).toUpperCase(), className: 'file-pill--text' };
}

export function renderToolbar(
    payload: FilePreviewStructuredContent,
    canCopy: boolean,
    htmlMode: HtmlPreviewMode,
    isExpanded: boolean,
    canOpenInFolder: boolean
): string {
    const supportsPreview = payload.fileType !== 'unsupported';
    const copyDisabled = canCopy ? '' : 'disabled';
    const copyTitle = canCopy ? 'Copy source' : 'Copy unavailable';
    const copyIcon = `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M8 8h10v12H8z"></path>
        <path d="M6 4h10v2H8v10H6z"></path>
      </svg>
    `;
    const folderDisabled = canOpenInFolder ? '' : 'disabled';
    const folderTitle = canOpenInFolder ? 'Open in folder' : 'Open in folder unavailable';
    const folderIcon = `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M10 4l2 2h8v12H4V4z"></path>
      </svg>
    `;
    const previewIcon = isExpanded
        ? `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 14l5-5 5 5z"></path></svg>`
        : `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 10l5 5 5-5z"></path></svg>`;

    const htmlModeButton = payload.fileType === 'html'
        ? `
          <button class="icon-button icon-button--secondary" id="toggle-html-mode" title="${htmlMode === 'rendered' ? 'Show source' : 'Show rendered'}" aria-label="${htmlMode === 'rendered' ? 'Show source' : 'Show rendered'}">
            ${htmlMode === 'rendered'
                ? `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 5c5.2 0 9.3 4.4 10.6 6-1.3 1.6-5.4 6-10.6 6S2.7 12.6 1.4 11C2.7 9.4 6.8 5 12 5zm0 2.2A3.8 3.8 0 1 0 12 14.8a3.8 3.8 0 0 0 0-7.6z"></path></svg>`
                : `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9.4 16.6L4.8 12l4.6-4.6L8 6 2 12l6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"></path></svg>`
            }
          </button>
        `
        : '';

    const filePill = inferFilePill(payload);
    const leadingActions = supportsPreview
        ? `
          <button class="icon-button" id="toggle-expand" title="${isExpanded ? 'Hide preview' : 'Show preview'}" aria-label="${isExpanded ? 'Hide preview' : 'Show preview'}">
            ${previewIcon}
          </button>
        `
        : '';
    const trailingActions = supportsPreview
        ? `
          ${htmlModeButton}
          <button class="icon-button" id="copy-source" ${copyDisabled} title="${copyTitle}" aria-label="${copyTitle}">
            ${copyIcon}
          </button>
        `
        : '';

    return renderToolHeader({
        pillLabel: filePill.label,
        pillClassName: filePill.className,
        title: payload.fileName,
        subtitle: payload.filePath,
        badges: [],
        actionsHtml: `
          ${leadingActions}
          <button class="icon-button" id="open-in-folder" ${folderDisabled} title="${folderTitle}" aria-label="${folderTitle}">
            ${folderIcon}
          </button>
          ${trailingActions}
        `
    });
}
