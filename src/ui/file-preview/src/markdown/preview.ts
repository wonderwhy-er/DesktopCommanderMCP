import { renderMarkdown } from '../components/markdown-renderer.js';

export function getRenderedMarkdownCopyText(content: string): string {
    const html = renderMarkdown(content);
    const normalizedHtml = html
        .replace(/<\s*br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<\/h[1-6]>/gi, '\n\n')
        .replace(/<\/li>/gi, '\n')
        .replace(/<li>/gi, '- ')
        .replace(/<[^>]+>/g, '');

    return normalizedHtml
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

