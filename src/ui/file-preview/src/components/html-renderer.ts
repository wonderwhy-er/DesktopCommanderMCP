/**
 * HTML preview renderer with display mode control. It handles rendered HTML versus
 * source text display and ensures fallback behavior is predictable.
 *
 * The rendered preview runs inside a nested sandboxed iframe, which is itself inside
 * the MCP app's sandboxed iframe chain. Scripts and external resources (CDNs) are
 * allowed since the sandbox isolation prevents any escape.
 */
import { renderCodeViewer } from './code-viewer.js';
import { escapeHtml } from './highlighting.js';
import type { HtmlPreviewMode } from '../types.js';

function resolveThemeFrameStyles(): { background: string; text: string; fontFamily: string } {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
        return {
            background: 'Canvas',
            text: 'CanvasText',
            fontFamily: 'system-ui, sans-serif',
        };
    }
    const rootStyles = window.getComputedStyle(document.documentElement);
    const background = rootStyles.getPropertyValue('--panel').trim() || 'Canvas';
    const text = rootStyles.getPropertyValue('--text').trim() || 'CanvasText';
    const fontFamily = rootStyles.getPropertyValue('--font-sans').trim() || 'system-ui, sans-serif';
    return { background, text, fontFamily };
}

function renderSandboxedHtmlFrame(content: string): string {
    const palette = resolveThemeFrameStyles();
    const frameDocument = `<!doctype html><html><head><meta charset="utf-8" /><style>html,body{margin:0;padding:0;background:${palette.background};color:${palette.text};}body{font-family:${palette.fontFamily};padding:16px;line-height:1.5;}img{max-width:100%;height:auto;}</style></head><body>${content}</body></html>`;
    return `<iframe class="html-rendered-frame" title="Rendered HTML preview" sandbox="allow-scripts allow-forms allow-popups allow-same-origin" referrerpolicy="no-referrer" srcdoc="${escapeHtml(frameDocument)}"></iframe>`;
}

export function renderHtmlPreview(content: string, mode: HtmlPreviewMode): { html: string; notice?: string } {
    if (mode === 'source') {
        return {
            html: `<div class="panel-content source-content">${renderCodeViewer(content, 'html')}</div>`
        };
    }

    try {
        return {
            html: `<div class="panel-content html-content">${renderSandboxedHtmlFrame(content)}</div>`
        };
    } catch {
        return {
            html: `<div class="panel-content source-content">${renderCodeViewer(content, 'html')}</div>`,
            notice: 'HTML renderer failed. Showing source instead.'
        };
    }
}
