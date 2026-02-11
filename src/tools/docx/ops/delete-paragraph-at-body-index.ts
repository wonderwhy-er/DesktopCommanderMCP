/**
 * Op: delete_paragraph_at_body_index
 *
 * Remove the w:p element at the given bodyChildIndex.
 * Skips if the child is not a w:p.
 *
 * NOTE: This is a structural op — it decreases bodyChildCount by 1.
 * The orchestrator must account for this when validating invariants.
 */

import { getBodyChildren } from '../dom.js';
import type { DeleteParagraphAtBodyIndexOp, OpResult } from '../types.js';

export function applyDeleteParagraphAtBodyIndex(
    body: Element,
    op: DeleteParagraphAtBodyIndexOp,
): OpResult {
    const children = getBodyChildren(body);
    const idx = op.bodyChildIndex;

    if (idx < 0 || idx >= children.length) {
        return { op, status: 'skipped', matched: 0, reason: 'index_out_of_range' };
    }

    const child = children[idx];
    if (child.nodeName !== 'w:p') {
        return { op, status: 'skipped', matched: 0, reason: 'not_a_paragraph' };
    }

    body.removeChild(child);
    return { op, status: 'applied', matched: 1 };
}

