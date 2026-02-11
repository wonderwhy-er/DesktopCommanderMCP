/**
 * Op: insert_paragraph_after_text
 *
 * Find the FIRST paragraph whose trimmed text === `after`, then insert
 * a new w:p immediately after it.  Optionally applies a style to the
 * new paragraph.
 *
 * NOTE: This is a structural op — it increases bodyChildCount by 1.
 * The orchestrator must account for this when validating invariants.
 */

import { getBodyChildren, getParagraphText, nodeListToArray } from '../dom.js';
import type { InsertParagraphAfterTextOp, OpResult } from '../types.js';

export function applyInsertParagraphAfterText(
    body: Element,
    op: InsertParagraphAfterTextOp,
): OpResult {
    const children = getBodyChildren(body);
    const target = op.after.trim();

    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.nodeName !== 'w:p') continue;

        if (getParagraphText(child).trim() === target) {
            const doc = body.ownerDocument;
            if (!doc) return { op, status: 'skipped', matched: 0, reason: 'no_owner_document' };

            // Build new paragraph: <w:p><w:r><w:t>text</w:t></w:r></w:p>
            const newP = doc.createElement('w:p');

            // Optionally set style
            if (op.style) {
                const pPr = doc.createElement('w:pPr');
                const pStyle = doc.createElement('w:pStyle');
                pStyle.setAttribute('w:val', op.style);
                pPr.appendChild(pStyle);
                newP.appendChild(pPr);
            }

            const newR = doc.createElement('w:r');
            const newT = doc.createElement('w:t');
            newT.setAttribute('xml:space', 'preserve');
            newT.textContent = op.text;
            newR.appendChild(newT);
            newP.appendChild(newR);

            // Insert after the matched child
            const nextSibling = child.nextSibling;
            if (nextSibling) {
                body.insertBefore(newP, nextSibling);
            } else {
                body.appendChild(newP);
            }

            return { op, status: 'applied', matched: 1 };
        }
    }

    return { op, status: 'skipped', matched: 0, reason: 'no_match' };
}

