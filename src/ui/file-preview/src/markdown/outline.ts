import type { DocumentOutlineItem } from '../document-outline.js';
import { GFM, parser } from '@lezer/markdown';
import { createSlugTracker } from './slugify.js';

const outlineParser = parser.configure([GFM]);
const HEADING_NODE_PATTERN = /^(?:ATXHeading|SetextHeading)([1-6])$/;

function buildLineStarts(source: string): number[] {
    const starts = [0];
    for (let index = 0; index < source.length; index += 1) {
        if (source[index] === '\n') {
            starts.push(index + 1);
        }
    }
    return starts;
}

function lineNumberForOffset(lineStarts: number[], offset: number): number {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (lineStarts[mid] <= offset) {
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    return Math.max(1, high + 1);
}

function stripInlineMarkdown(text: string): string {
    return text
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/\[\[([^\]|#]*(?:#[^\]|]+)?)(?:\|([^\]]+))?\]\]/g, (_match, target, alias) => alias || target)
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/~~([^~]+)~~/g, '$1')
        .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
        .replace(/(^|[^_])_([^_]+)_/g, '$1$2')
        .replace(/<[^>]+>/g, '')
        .replace(/\\([\\`*{}\[\]()#+\-.!_>~|])/g, '$1')
        .trim();
}

function readHeadingText(source: string, from: number, to: number, nodeName: string): string {
    const rawHeading = source.slice(from, to);
    const isSetext = nodeName.startsWith('SetextHeading');
    const text = isSetext
        ? rawHeading.split(/\r?\n/)[0] ?? ''
        : rawHeading
            .replace(/^\s{0,3}#{1,6}\s*/, '')
            .replace(/\s+#+\s*$/, '');
    return stripInlineMarkdown(text);
}

export function extractMarkdownOutline(source: string): DocumentOutlineItem[] {
    const tree = outlineParser.parse(source);
    const cursor = tree.cursor();
    const nextSlug = createSlugTracker();
    const outline: DocumentOutlineItem[] = [];
    const lineStarts = buildLineStarts(source);

    cursor.iterate((node) => {
        const match = node.name.match(HEADING_NODE_PATTERN);
        if (!match) {
            return;
        }

        const level = Number.parseInt(match[1], 10);
        const text = readHeadingText(source, node.from, node.to, node.name);
        if (!text) {
            return;
        }

        outline.push({
            id: nextSlug(text),
            text,
            level,
            line: lineNumberForOffset(lineStarts, node.from),
        });
    });

    return outline;
}
