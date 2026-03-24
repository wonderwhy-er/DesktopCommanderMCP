/**
 * Markdown rendering pipeline for preview mode. It configures markdown-it and highlighting so markdown content is rendered consistently with code block support.
 */
// markdown-it is intentionally typed locally here to avoid maintaining global ambient module declarations.
// @ts-expect-error markdown-it does not provide local TypeScript typings in this setup.
import MarkdownIt from 'markdown-it';
import { highlightSource } from './highlighting.js';
import { rewriteWikiLinks } from '../markdown-workspace/linking.js';
import { createSlugTracker } from '../markdown-workspace/slugify.js';

interface MarkdownRenderer {
    render: (source: string, env?: Record<string, unknown>) => string;
    renderer: {
        rules: Record<string, (...args: unknown[]) => string>;
    };
}

type MarkdownItConstructor = new (options?: {
    html?: boolean;
    linkify?: boolean;
    typographer?: boolean;
    highlight?: (code: string, language: string) => string;
}) => MarkdownRenderer;

const MarkdownItCtor = MarkdownIt as unknown as MarkdownItConstructor;

function extractInlineText(token: Record<string, unknown> | undefined): string {
    if (!token) {
        return '';
    }

    const children = Array.isArray(token.children) ? token.children : [];
    if (children.length === 0) {
        return typeof token.content === 'string' ? token.content : '';
    }

    return children.map((child) => {
        if (typeof child.content === 'string') {
            return child.content;
        }
        return '';
    }).join('');
}

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

const renderHeadingOpen = markdown.renderer.rules.heading_open;
markdown.renderer.rules.heading_open = (...args: unknown[]): string => {
    const tokens = args[0] as Array<Record<string, unknown>>;
    const index = args[1] as number;
    const options = args[2] as unknown;
    const environment = (args[3] as Record<string, unknown> | undefined) ?? {};
    const self = args[4] as { renderToken: (tokens: Array<Record<string, unknown>>, index: number, options: unknown) => string };
    const nextSlug = typeof environment.nextSlug === 'function'
        ? environment.nextSlug as (text: string) => string
        : createSlugTracker();
    environment.nextSlug = nextSlug;

    const inlineToken = tokens[index + 1];
    const headingText = extractInlineText(inlineToken).trim();
    const headingId = nextSlug(headingText || 'section');
    const token = tokens[index] as { attrSet?: (name: string, value: string) => void };
    token.attrSet?.('id', headingId);
    token.attrSet?.('data-heading-id', headingId);

    if (typeof renderHeadingOpen === 'function') {
        return renderHeadingOpen(...args);
    }

    return self.renderToken(tokens, index, options);
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
    return markdown.render(rewriteWikiLinks(content), { nextSlug: createSlugTracker() });
}
