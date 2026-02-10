/**
 * Op: set_color_for_paragraph_exact
 *
 * Find FIRST paragraph whose trimmed text === `text`.
 * Apply run-level colour to every w:r in that paragraph.
 */

import { getBodyChildren, getParagraphText, ensureRunColor } from '../dom.js';
import type { SetColorForParagraphExactOp, OpResult } from '../types.js';

export function applySetColorForParagraphExact(
    body: Element,
    op: SetColorForParagraphExactOp,
): OpResult {
    const children = getBodyChildren(body);
    const target = op.text.trim();

    for (const child of children) {
        if (child.nodeName !== 'w:p') continue;
        if (getParagraphText(child).trim() !== target) continue;

        const runs = child.getElementsByTagName('w:r');
        for (let i = 0; i < runs.length; i++) {
            ensureRunColor(runs.item(i) as Element, op.color);
        }
        return { op, status: 'applied', matched: 1 };
    }

    return { op, status: 'skipped', matched: 0, reason: 'no_match' };
}

