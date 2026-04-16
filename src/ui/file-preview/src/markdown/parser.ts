// markdown-it is intentionally typed locally here to avoid maintaining ambient module declarations.
import MarkdownIt from 'markdown-it';
import type { MarkdownSlugTracker } from './slugify.js';
import { rewriteWikiLinks } from './linking.js';
import { extractInlineText } from './utils.js';

export interface MarkdownToken {
    type?: string;
    tag?: string;
    map?: number[];
    children?: unknown;
    content?: unknown;
    attrSet?: (name: string, value: string) => void;
    attrGet?: (name: string) => string | null;
    attrs?: Array<[string, string]>;
}

interface MarkdownItInstance {
    render: (source: string, env?: Record<string, unknown>) => string;
    parse: (source: string, env?: Record<string, unknown>) => MarkdownToken[];
    renderer: {
        rules: Record<string, (...args: unknown[]) => string>;
    };
}

type MarkdownItConstructor = new (options?: {
    html?: boolean;
    linkify?: boolean;
    typographer?: boolean;
    highlight?: (code: string, language: string) => string;
}) => MarkdownItInstance;

export interface MarkdownHeadingProjection {
    id: string;
    text: string;
    level: number;
    line: number;
}

const MarkdownItCtor = MarkdownIt as unknown as MarkdownItConstructor;

export function createMarkdownIt(options: {
    highlight?: (code: string, language: string) => string;
} = {}): MarkdownItInstance {
    return new MarkdownItCtor({
        html: false,
        linkify: true,
        typographer: false,
        ...(options.highlight ? { highlight: options.highlight } : {}),
    });
}

export function prepareMarkdownSource(source: string): string {
    return rewriteWikiLinks(source);
}

export function readHeadingProjection(
    tokens: MarkdownToken[],
    index: number,
    nextSlug: MarkdownSlugTracker
): MarkdownHeadingProjection | null {
    const token = tokens[index];
    if (token?.type !== 'heading_open' || typeof token.tag !== 'string') {
        return null;
    }

    const level = Number.parseInt(token.tag.replace(/^h/i, ''), 10);
    if (!Number.isFinite(level)) {
        return null;
    }

    const inlineToken = tokens[index + 1] as Record<string, unknown> | undefined;
    const text = extractInlineText(inlineToken).trim();
    if (!text) {
        return null;
    }

    const lineMap = Array.isArray(token.map) ? token.map : undefined;
    return {
        id: nextSlug(text),
        text,
        level,
        line: typeof lineMap?.[0] === 'number' ? lineMap[0] + 1 : index + 1,
    };
}
