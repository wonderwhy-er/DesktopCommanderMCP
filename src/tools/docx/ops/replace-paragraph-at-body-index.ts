/**
 * Op: replace_paragraph_at_body_index
 *
 * Target the child of w:body at the given bodyChildIndex.
 * If it is not a w:p → skip with reason "not_a_paragraph".
 * Otherwise apply the same minimal text replacement.
 */

import { getBodyChildren, setParagraphTextMinimal } from '../dom.js';
import type { ReplaceParagraphAtBodyIndexOp, OpResult } from '../types.js';

export function applyReplaceParagraphAtBodyIndex(
    body: Element,
    op: ReplaceParagraphAtBodyIndexOp,
): OpResult {
    const children = getBodyChildren(body);

    if (op.bodyChildIndex < 0 || op.bodyChildIndex >= children.length) {
        return {
            op,
            status: 'skipped',
            matched: 0,
            reason: `bodyChildIndex ${op.bodyChildIndex} out of range (0..${children.length - 1})`,
        };
    }

    const child = children[op.bodyChildIndex];

    if (child.nodeName !== 'w:p') {
        return { op, status: 'skipped', matched: 0, reason: 'not_a_paragraph' };
    }

    setParagraphTextMinimal(child, op.to);
    return { op, status: 'applied', matched: 1 };
}

