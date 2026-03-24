// markdown-it is intentionally typed locally here to avoid maintaining ambient module declarations.
// @ts-expect-error markdown-it does not provide local TypeScript typings in this setup.
import MarkdownIt from 'markdown-it';
import { rewriteWikiLinks } from './linking.js';
import { createSlugTracker } from './slugify.js';

interface MarkdownOutlineParser {
    parse: (source: string, env?: Record<string, unknown>) => Array<Record<string, unknown>>;
}

type MarkdownItConstructor = new (options?: {
    html?: boolean;
    linkify?: boolean;
    typographer?: boolean;
}) => MarkdownOutlineParser;

const MarkdownItCtor = MarkdownIt as unknown as MarkdownItConstructor;
const outlineParser = new MarkdownItCtor({
    html: false,
    linkify: true,
    typographer: false,
});

export interface MarkdownOutlineItem {
    id: string;
    text: string;
    level: number;
    line: number;
}

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

export function extractMarkdownOutline(source: string): MarkdownOutlineItem[] {
    const tokens = outlineParser.parse(rewriteWikiLinks(source), {});
    const nextSlug = createSlugTracker();
    const outline: MarkdownOutlineItem[] = [];

    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token.type !== 'heading_open' || typeof token.tag !== 'string') {
            continue;
        }

        const level = Number.parseInt(token.tag.replace(/^h/i, ''), 10);
        if (!Number.isFinite(level)) {
            continue;
        }

        const inlineToken = tokens[index + 1];
        const text = extractInlineText(inlineToken).trim();
        if (!text) {
            continue;
        }

        const lineMap = Array.isArray(token.map) ? token.map : undefined;
        outline.push({
            id: nextSlug(text),
            text,
            level,
            line: Array.isArray(lineMap) && typeof lineMap[0] === 'number' ? lineMap[0] + 1 : outline.length + 1,
        });
    }

    return outline;
}
