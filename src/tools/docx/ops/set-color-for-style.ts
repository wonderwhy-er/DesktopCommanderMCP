/**
 * Op: set_color_for_style
 *
 * For every paragraph whose w:pPr/w:pStyle/@w:val === style,
 * set run-level colour on every w:r in that paragraph.
 * Does NOT modify word/styles.xml — only in-document run formatting.
 */

import { getBodyChildren, getParagraphStyle, ensureRunColor } from '../dom.js';
import type { SetColorForStyleOp, OpResult } from '../types.js';

export function applySetColorForStyle(
    body: Element,
    op: SetColorForStyleOp,
): OpResult {
    const children = getBodyChildren(body);
    let matched = 0;

    for (const child of children) {
        if (child.nodeName !== 'w:p') continue;
        if (getParagraphStyle(child) !== op.style) continue;

        const runs = child.getElementsByTagName('w:r');
        for (let i = 0; i < runs.length; i++) {
            ensureRunColor(runs.item(i) as Element, op.color);
        }
        matched++;
    }

    if (matched === 0) {
        return { op, status: 'skipped', matched: 0, reason: 'no_match' };
    }
    return { op, status: 'applied', matched };
}

