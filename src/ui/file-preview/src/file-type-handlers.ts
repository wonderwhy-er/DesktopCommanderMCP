import { formatJsonIfPossible, inferLanguageFromPath, renderCodeViewer } from './components/code-viewer.js';
import { escapeHtml } from './components/highlighting.js';
import { renderHtmlPreview } from './components/html-renderer.js';
import { renderDirectoryBody } from './directory-controller.js';
import { stripReadStatusLine } from './document-workspace.js';
import { isAllowedImageMimeType, normalizeImageMimeType } from './image-preview.js';
import type { FileTypeCapabilities, RenderBodyResult, RenderPayload } from './model.js';
import type { MarkdownController } from './markdown/controller.js';
import { isLikelyUrl } from './payload-utils.js';
import type { HtmlPreviewMode } from './types.js';

function renderRawFallback(source: string): string {
    return `<pre class="code-viewer"><code class="hljs language-text">${escapeHtml(source)}</code></pre>`;
}

function renderImageBody(payload: RenderPayload): RenderBodyResult {
    const mimeType = normalizeImageMimeType(payload.mimeType);
    if (!isAllowedImageMimeType(mimeType)) {
        return {
            notice: 'Preview is unavailable for this image format.',
            html: '<div class="panel-content source-content"></div>',
        };
    }

    if (!payload.imageData || payload.imageData.trim().length === 0) {
        return {
            notice: 'Preview is unavailable because image data is missing.',
            html: '<div class="panel-content source-content"></div>',
        };
    }

    const src = `data:${mimeType};base64,${payload.imageData}`;
    return {
        html: `<div class="panel-content image-content"><div class="image-preview"><img src="${escapeHtml(src)}" alt="${escapeHtml(payload.fileName)}" loading="eager" decoding="async"></div></div>`,
    };
}

interface FileTypeHandler {
    getCapabilities: (payload: RenderPayload) => FileTypeCapabilities;
    renderBody: (options: {
        payload: RenderPayload;
        htmlMode: HtmlPreviewMode;
        startLine: number;
        markdownController: MarkdownController;
    }) => RenderBodyResult;
}

function buildPreviewCapabilities(payload: RenderPayload, canCopy: boolean): FileTypeCapabilities {
    return {
        supportsPreview: true,
        canCopy,
        canOpenInFolder: !isLikelyUrl(payload.filePath),
    };
}

const handlerRegistry: Partial<Record<RenderPayload['fileType'], FileTypeHandler>> = {
    directory: {
        getCapabilities: (payload) => buildPreviewCapabilities(payload, false),
        renderBody: ({ payload }) => renderDirectoryBody(stripReadStatusLine(payload.content), payload.filePath),
    },
    html: {
        getCapabilities: (payload) => buildPreviewCapabilities(payload, true),
        renderBody: ({ payload, htmlMode }) => renderHtmlPreview(stripReadStatusLine(payload.content), htmlMode),
    },
    image: {
        getCapabilities: (payload) => buildPreviewCapabilities(payload, false),
        renderBody: ({ payload }) => renderImageBody(payload),
    },
    markdown: {
        getCapabilities: (payload) => buildPreviewCapabilities(payload, false),
        renderBody: ({ payload, markdownController }) => {
            try {
                return markdownController.buildBody(payload);
            } catch {
                return {
                    notice: 'Markdown renderer failed. Showing raw source instead.',
                    html: `<div class="panel-content source-content">${renderRawFallback(stripReadStatusLine(payload.content))}</div>`,
                };
            }
        },
    },
    text: {
        getCapabilities: (payload) => buildPreviewCapabilities(payload, true),
        renderBody: ({ payload, startLine }) => {
            const cleanedContent = stripReadStatusLine(payload.content);
            const detectedLanguage = inferLanguageFromPath(payload.filePath);
            const formatted = formatJsonIfPossible(cleanedContent, payload.filePath);
            return {
                notice: formatted.notice,
                html: `<div class="panel-content source-content">${renderCodeViewer(formatted.content, detectedLanguage, startLine)}</div>`,
            };
        },
    },
    unsupported: {
        getCapabilities: () => ({
            supportsPreview: false,
            canCopy: false,
            canOpenInFolder: true,
        }),
        renderBody: () => ({
            notice: 'Preview is not available for this file type.',
            html: '<div class="panel-content source-content"></div>',
        }),
    },
};

export function getFileTypeCapabilities(payload: RenderPayload): FileTypeCapabilities {
    return handlerRegistry[payload.fileType]?.getCapabilities(payload) ?? {
        supportsPreview: false,
        canCopy: false,
        canOpenInFolder: !isLikelyUrl(payload.filePath),
    };
}

export function renderPayloadBody(options: {
    payload: RenderPayload;
    htmlMode: HtmlPreviewMode;
    startLine: number;
    markdownController: MarkdownController;
}): RenderBodyResult {
    const handler = handlerRegistry[options.payload.fileType] ?? handlerRegistry.text!;
    return handler.renderBody(options);
}
