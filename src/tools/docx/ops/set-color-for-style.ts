/**
 * Op: set_color_for_style
 *
 * For every paragraph whose w:pPr/w:pStyle/@w:val === style,
 * set run-level colour on every w:r in that paragraph.
 *
 * This now includes paragraphs inside tables and other containers,
 * not just direct w:p children of w:body.
 *
 * Does NOT modify word/styles.xml — only in-document run formatting.
 */

import { getParagraphStyle, ensureRunColor } from '../dom.js';
import type { SetColorForStyleOp, OpResult } from '../types.js';

export function applySetColorForStyle(
    body: Element,
    op: SetColorForStyleOp,
): OpResult {
    // Traverse **all** paragraphs in the body.
    const paragraphs = body.getElementsByTagName('w:p');
    let matched = 0;

    for (let i = 0; i < paragraphs.length; i++) {
        const p = paragraphs.item(i) as Element;
        if (getParagraphStyle(p) !== op.style) continue;

        const runs = p.getElementsByTagName('w:r');
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

