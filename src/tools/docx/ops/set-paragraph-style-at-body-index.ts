/**
 * Op: set_paragraph_style_at_body_index
 *
 * Set (or replace) the paragraph style (w:pPr/w:pStyle) at a given
 * bodyChildIndex.  Skips if the child is not a w:p.
 */

import { getBodyChildren, nodeListToArray } from '../dom.js';
import type { SetParagraphStyleAtBodyIndexOp, OpResult } from '../types.js';

export function applySetParagraphStyleAtBodyIndex(
    body: Element,
    op: SetParagraphStyleAtBodyIndexOp,
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

    const doc = child.ownerDocument;
    if (!doc) return { op, status: 'skipped', matched: 0, reason: 'no_owner_document' };

    // Find or create w:pPr
    let pPr: Element | null = null;
    for (const n of nodeListToArray(child.childNodes)) {
        if (n.nodeType === 1 && (n as Element).nodeName === 'w:pPr') {
            pPr = n as Element;
            break;
        }
    }
    if (!pPr) {
        pPr = doc.createElement('w:pPr');
        if (child.firstChild) {
            child.insertBefore(pPr, child.firstChild);
        } else {
            child.appendChild(pPr);
        }
    }

    // Find or create w:pStyle inside pPr
    let pStyle: Element | null = null;
    for (const n of nodeListToArray(pPr.childNodes)) {
        if (n.nodeType === 1 && (n as Element).nodeName === 'w:pStyle') {
            pStyle = n as Element;
            break;
        }
    }
    if (!pStyle) {
        pStyle = doc.createElement('w:pStyle');
        if (pPr.firstChild) {
            pPr.insertBefore(pStyle, pPr.firstChild);
        } else {
            pPr.appendChild(pStyle);
        }
    }

    pStyle.setAttribute('w:val', op.style);
    return { op, status: 'applied', matched: 1 };
}

