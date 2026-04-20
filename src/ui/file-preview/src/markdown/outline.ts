import type { DocumentOutlineItem } from '../document-outline.js';
import { createMarkdownIt, prepareMarkdownSource, readHeadingProjection } from './parser.js';
import { createSlugTracker } from './slugify.js';
const outlineParser = createMarkdownIt();

export function extractMarkdownOutline(source: string): DocumentOutlineItem[] {
    const tokens = outlineParser.parse(prepareMarkdownSource(source), {});
    const nextSlug = createSlugTracker();
    const outline: DocumentOutlineItem[] = [];

    for (let index = 0; index < tokens.length; index += 1) {
        const heading = readHeadingProjection(tokens, index, nextSlug);
        if (!heading) {
            continue;
        }

        outline.push(heading);
    }

    return outline;
}
