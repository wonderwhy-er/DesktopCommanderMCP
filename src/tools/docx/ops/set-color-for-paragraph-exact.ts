/**
 * Op: set_color_for_paragraph_exact
 *
 * Find FIRST paragraph whose trimmed text === `text` **anywhere in the body**,
 * including paragraphs inside tables and other containers.
 * Apply run-level colour to every w:r in that paragraph.
 */

import { getParagraphText, ensureRunColor } from '../dom.js';
import type { SetColorForParagraphExactOp, OpResult } from '../types.js';

export function applySetColorForParagraphExact(
    body: Element,
    op: SetColorForParagraphExactOp,
): OpResult {
    const target = op.text.trim();

    // Traverse **all** paragraphs in the body, not just direct children.
    const paragraphs = body.getElementsByTagName('w:p');

    for (let i = 0; i < paragraphs.length; i++) {
        const p = paragraphs.item(i) as Element;
        if (getParagraphText(p).trim() !== target) continue;

        const runs = p.getElementsByTagName('w:r');
        for (let i = 0; i < runs.length; i++) {
            ensureRunColor(runs.item(i) as Element, op.color);
        }
        return { op, status: 'applied', matched: 1 };
    }

    return { op, status: 'skipped', matched: 0, reason: 'no_match' };
}

