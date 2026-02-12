/**
 * Op: replace_paragraph_text_exact
 *
 * Find FIRST paragraph whose trimmed text === `from` **anywhere in the body**,
 * including paragraphs inside table cells, content controls, etc.
 *
 * Replace only the first w:t with `to`; clear other w:t nodes.
 * Does NOT remove/recreate runs or paragraph properties.
 *
 * Note: For table cells with multiple paragraphs, use `replace_table_cell_text`
 * instead, which matches the full cell text (all paragraphs joined).
 */

import { getParagraphText, setParagraphTextMinimal, nodeListToArray } from '../dom.js';
import type { ReplaceParagraphTextExactOp, OpResult } from '../types.js';

export function applyReplaceParagraphTextExact(
    body: Element,
    op: ReplaceParagraphTextExactOp,
): OpResult {
    const target = op.from.trim();

    // Traverse **all** paragraphs in the body, not just direct body children.
    // This includes paragraphs inside table cells, content controls, etc.
    const paragraphs = body.getElementsByTagName('w:p');

    for (let i = 0; i < paragraphs.length; i++) {
        const p = paragraphs.item(i) as Element;
        const paragraphText = getParagraphText(p).trim();

        if (paragraphText === target) {
            setParagraphTextMinimal(p, op.to);
            return { op, status: 'applied', matched: 1 };
        }
    }

    return { op, status: 'skipped', matched: 0, reason: 'no_match' };
}

