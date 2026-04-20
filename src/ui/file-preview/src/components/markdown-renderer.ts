/**
 * Markdown rendering pipeline for preview mode. It configures markdown-it and highlighting so markdown content is rendered consistently with code block support.
 */
import { highlightSource } from './highlighting.js';
import { createMarkdownIt, prepareMarkdownSource, readHeadingProjection, type MarkdownToken } from '../markdown/parser.js';
import { createSlugTracker } from '../markdown/slugify.js';

const markdown = createMarkdownIt({
    highlight(code: string, language: string): string {
        const normalizedLanguage = (language || 'text').toLowerCase();
        const highlighted = highlightSource(code, normalizedLanguage);
        return `<pre class="code-viewer"><code class="hljs language-${normalizedLanguage}">${highlighted}</code></pre>`;
    }
});

const renderHeadingOpen = markdown.renderer.rules.heading_open;
markdown.renderer.rules.heading_open = (...args: unknown[]): string => {
    const tokens = args[0] as MarkdownToken[];
    const index = args[1] as number;
    const options = args[2] as unknown;
    const environment = (args[3] as Record<string, unknown> | undefined) ?? {};
    const self = args[4] as { renderToken: (tokens: Array<Record<string, unknown>>, index: number, options: unknown) => string };
    const nextSlug = typeof environment.nextSlug === 'function'
        ? environment.nextSlug as (text: string) => string
        : createSlugTracker();
    environment.nextSlug = nextSlug;

    const heading = readHeadingProjection(tokens, index, nextSlug);
    const token = tokens[index] as { attrSet?: (name: string, value: string) => void };
    if (heading) {
        token.attrSet?.('id', heading.id);
        token.attrSet?.('data-heading-id', heading.id);
    }

    if (typeof renderHeadingOpen === 'function') {
        return renderHeadingOpen(...args);
    }

    return self.renderToken(tokens as Array<Record<string, unknown>>, index, options);
};

const renderLinkOpen = markdown.renderer.rules.link_open;
markdown.renderer.rules.link_open = (...args: unknown[]): string => {
    const tokens = args[0] as Array<Record<string, unknown>>;
    const index = args[1] as number;
    const options = args[2] as unknown;
    const self = args[4] as { renderToken: (tokens: Array<Record<string, unknown>>, index: number, options: unknown) => string };
    const token = tokens[index] as { attrSet?: (name: string, value: string) => void; attrGet?: (name: string) => string | null; attrs?: Array<[string, string]> };
    token.attrSet?.('data-markdown-link', 'true');
    const title = token.attrGet?.('title');
    if (title?.startsWith('mcp-wiki:')) {
        const rawWikiLink = decodeURIComponent(title.slice('mcp-wiki:'.length));
        token.attrSet?.('data-wiki-link', rawWikiLink);
        if (Array.isArray(token.attrs)) {
            token.attrs = token.attrs.filter(([name]) => name !== 'title');
        }
    }

    if (typeof renderLinkOpen === 'function') {
        return renderLinkOpen(...args);
    }

    return self.renderToken(tokens, index, options);
};

export function renderMarkdown(content: string): string {
    return markdown.render(prepareMarkdownSource(content), { nextSlug: createSlugTracker() });
}
