/**
 * HTML preview renderer with guardrails for display modes. It controls when to show rendered HTML versus source text and ensures fallback behavior is predictable.
 */
import { renderCodeViewer } from './code-viewer.js';
import { escapeHtml } from './highlighting.js';
import type { HtmlPreviewMode } from '../types.js';

interface HtmlRenderOptions {
    allowUnsafeScripts?: boolean;
}

function sanitizeHtml(rawHtml: string): string {
    const blockedTagPattern = /<\/?(script|iframe|object|embed|link|meta|base|form)[^>]*>/gi;
    let safe = rawHtml.replace(blockedTagPattern, '');

    safe = safe.replace(/\son[a-z]+\s*=\s*(".*?"|'.*?'|[^\s>]+)/gi, '');
    safe = safe.replace(/\s(href|src)\s*=\s*(".*?"|'.*?'|[^\s>]+)/gi, (match, attr, value) => {
        const strippedValue = String(value).replace(/^['"]|['"]$/g, '').trim().toLowerCase();
        if (strippedValue.startsWith('javascript:')) {
            return ` ${attr}="#"`;
        }
        if (strippedValue.startsWith('data:text/html')) {
            return ` ${attr}="#"`;
        }
        return match;
    });

    return safe;
}

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

function renderSandboxedHtmlFrame(content: string, allowUnsafeScripts: boolean): string {
    const htmlContent = allowUnsafeScripts ? content : sanitizeHtml(content);
    const csp = allowUnsafeScripts
        ? ''
        : `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline';">`;
    const sandbox = allowUnsafeScripts ? 'allow-scripts allow-forms allow-popups' : '';
    const palette = resolveThemeFrameStyles();
    const frameDocument = `<!doctype html><html><head><meta charset="utf-8" />${csp}<style>html,body{margin:0;padding:0;background:${palette.background};color:${palette.text};}body{font-family:${palette.fontFamily};padding:16px;line-height:1.5;}img{max-width:100%;height:auto;}</style></head><body>${htmlContent}</body></html>`;
    return `<iframe class="html-rendered-frame" title="Rendered HTML preview" sandbox="${sandbox}" referrerpolicy="no-referrer" srcdoc="${escapeHtml(frameDocument)}"></iframe>`;
}

export function renderHtmlPreview(content: string, mode: HtmlPreviewMode, options: HtmlRenderOptions = {}): { html: string; notice?: string } {
    if (mode === 'source') {
        return {
            html: `<div class="panel-content source-content">${renderCodeViewer(content, 'html')}</div>`
        };
    }

    try {
        return {
            html: `<div class="panel-content html-content">${renderSandboxedHtmlFrame(content, options.allowUnsafeScripts === true)}</div>`
        };
    } catch {
        return {
            html: `<div class="panel-content source-content">${renderCodeViewer(content, 'html')}</div>`,
            notice: 'HTML renderer failed. Showing source instead.'
        };
    }
}
