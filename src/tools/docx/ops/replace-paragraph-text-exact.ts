/**
 * Op: replace_paragraph_text_exact
 *
 * Find FIRST paragraph whose trimmed text === `from`.
 * Replace only the first w:t with `to`; clear other w:t nodes.
 * Does NOT remove/recreate runs or paragraph properties.
 */

import { getBodyChildren, getParagraphText, setParagraphTextMinimal } from '../dom.js';
import type { ReplaceParagraphTextExactOp, OpResult } from '../types.js';

export function applyReplaceParagraphTextExact(
    body: Element,
    op: ReplaceParagraphTextExactOp,
): OpResult {
    const children = getBodyChildren(body);
    const target = op.from.trim();

    for (const child of children) {
        if (child.nodeName !== 'w:p') continue;

        if (getParagraphText(child).trim() === target) {
            setParagraphTextMinimal(child, op.to);
            return { op, status: 'applied', matched: 1 };
        }
    }

    return { op, status: 'skipped', matched: 0, reason: 'no_match' };
}

