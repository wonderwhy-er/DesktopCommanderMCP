/**
 * Markdown rendering pipeline for preview mode. It configures markdown-it and highlighting so markdown content is rendered consistently with code block support.
 */
// markdown-it is intentionally typed locally here to avoid maintaining global ambient module declarations.
// @ts-expect-error markdown-it does not provide local TypeScript typings in this setup.
import MarkdownIt from 'markdown-it';
import { highlightSource } from './highlighting.js';

interface MarkdownRenderer {
    render: (source: string) => string;
}

type MarkdownItConstructor = new (options?: {
    html?: boolean;
    linkify?: boolean;
    typographer?: boolean;
    highlight?: (code: string, language: string) => string;
}) => MarkdownRenderer;

const MarkdownItCtor = MarkdownIt as unknown as MarkdownItConstructor;

const markdown = new MarkdownItCtor({
    html: false,
    linkify: true,
    typographer: false,
    highlight(code: string, language: string): string {
        const normalizedLanguage = (language || 'text').toLowerCase();
        const highlighted = highlightSource(code, normalizedLanguage);
        return `<pre class="code-viewer"><code class="hljs language-${normalizedLanguage}">${highlighted}</code></pre>`;
    }
});

export function renderMarkdown(content: string): string {
    return markdown.render(content);
}
