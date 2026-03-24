import { renderMarkdown } from '../components/markdown-renderer.js';
import type { MarkdownOutlineItem } from './outline.js';
import { renderMarkdownToc } from './toc.js';

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

export function renderMarkdownWorkspacePreview(options: {
    content: string;
    outline: MarkdownOutlineItem[];
    activeHeadingId?: string | null;
    showToc?: boolean;
}): string {
    const tocHtml = options.showToc ? renderMarkdownToc(options.outline, options.activeHeadingId) : '';
    const hasToc = tocHtml.length > 0;

    return `
      <div class="markdown-workspace markdown-workspace--preview${hasToc ? ' markdown-workspace--with-toc' : ''}">
        ${tocHtml}
        <section class="markdown-workspace-main">
          <article class="markdown markdown-doc">${renderMarkdown(options.content)}</article>
        </section>
      </div>
    `;
}
