/**
 * Op: insert_table
 *
 * Insert a new w:tbl (table) relative to a paragraph anchor.
 *
 * Supports two positioning modes:
 *   - `after`  — insert immediately AFTER the first paragraph matching text
 *   - `before` — insert immediately BEFORE the first paragraph matching text
 *
 * Exactly one of `after` or `before` must be provided.
 *
 * Accepts `headers` (optional) and `rows` as string arrays.
 * Optionally accepts `colWidths` (array of numbers in twips).
 *
 * This is a structural op — increases bodyChildCount by 1.
 * The orchestrator must account for this when validating invariants.
 */

import { getBodyChildren, getParagraphText } from '../dom.js';
import { buildTable } from '../builders/index.js';
import type { InsertTableOp, OpResult } from '../types.js';

// ─── Op implementation ───────────────────────────────────────────────

export function applyInsertTable(
    body: Element,
    op: InsertTableOp,
): OpResult {
    // Determine anchor text and position
    const anchorText = op.before ?? op.after;
    const position: 'before' | 'after' = op.before ? 'before' : 'after';

    if (!anchorText) {
        return { op, status: 'skipped', matched: 0, reason: 'no_anchor: provide "after" or "before"' };
    }

    const children = getBodyChildren(body);
    const target = anchorText.trim();

    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.nodeName !== 'w:p') continue;

        if (getParagraphText(child).trim() === target) {
            const doc = body.ownerDocument;
            if (!doc) return { op, status: 'skipped', matched: 0, reason: 'no_owner_document' };

            const tbl = buildTable(doc, op);

            if (position === 'before') {
                // Insert BEFORE the matched paragraph
                body.insertBefore(tbl, child);
            } else {
                // Insert AFTER the matched paragraph
                const nextSibling = child.nextSibling;
                if (nextSibling) {
                    body.insertBefore(tbl, nextSibling);
                } else {
                    body.appendChild(tbl);
                }
            }

            return { op, status: 'applied', matched: 1 };
        }
    }

    return { op, status: 'skipped', matched: 0, reason: 'no_match' };
}
