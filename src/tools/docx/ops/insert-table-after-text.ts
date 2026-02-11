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
import type { InsertTableOp, OpResult } from '../types.js';

// ─── XML builders (private) ──────────────────────────────────────────

/**
 * Build a single <w:tc> cell element.
 * If `isHeader` is true, the run is bolded.
 */
function buildCell(doc: Document, text: string, isHeader: boolean, widthTwips?: number): Element {
    const tc = doc.createElement('w:tc');

    // Cell properties (width)
    if (widthTwips) {
        const tcPr = doc.createElement('w:tcPr');
        const tcW = doc.createElement('w:tcW');
        tcW.setAttribute('w:w', String(widthTwips));
        tcW.setAttribute('w:type', 'dxa');
        tcPr.appendChild(tcW);
        tc.appendChild(tcPr);
    }

    // Paragraph inside cell
    const p = doc.createElement('w:p');
    const r = doc.createElement('w:r');

    // Optional bold for header cells
    if (isHeader) {
        const rPr = doc.createElement('w:rPr');
        const b = doc.createElement('w:b');
        rPr.appendChild(b);
        r.appendChild(rPr);
    }

    const t = doc.createElement('w:t');
    t.setAttribute('xml:space', 'preserve');
    t.textContent = text;
    r.appendChild(t);
    p.appendChild(r);
    tc.appendChild(p);

    return tc;
}

/**
 * Build a <w:tr> row element.
 */
function buildRow(
    doc: Document,
    cells: string[],
    isHeader: boolean,
    colWidths?: number[],
): Element {
    const tr = doc.createElement('w:tr');

    for (let i = 0; i < cells.length; i++) {
        const width = colWidths?.[i];
        tr.appendChild(buildCell(doc, cells[i], isHeader, width));
    }

    return tr;
}

/**
 * Build a complete <w:tbl> element from the op specification.
 */
function buildTable(doc: Document, op: InsertTableOp): Element {
    const tbl = doc.createElement('w:tbl');

    // Table properties — bordered by default
    const tblPr = doc.createElement('w:tblPr');

    // Table style
    if (op.style) {
        const tblStyle = doc.createElement('w:tblStyle');
        tblStyle.setAttribute('w:val', op.style);
        tblPr.appendChild(tblStyle);
    }

    // Table width (auto by default)
    const tblW = doc.createElement('w:tblW');
    tblW.setAttribute('w:w', '0');
    tblW.setAttribute('w:type', 'auto');
    tblPr.appendChild(tblW);

    // Table borders (single-line, 4 pt, black)
    const tblBorders = doc.createElement('w:tblBorders');
    for (const side of ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'] as const) {
        const border = doc.createElement(`w:${side}`);
        border.setAttribute('w:val', 'single');
        border.setAttribute('w:sz', '4');
        border.setAttribute('w:space', '0');
        border.setAttribute('w:color', '000000');
        tblBorders.appendChild(border);
    }
    tblPr.appendChild(tblBorders);

    tbl.appendChild(tblPr);

    // Table grid (column definitions)
    const colCount = op.headers
        ? op.headers.length
        : op.rows.length > 0
            ? op.rows[0].length
            : 0;

    if (colCount > 0) {
        const tblGrid = doc.createElement('w:tblGrid');
        for (let c = 0; c < colCount; c++) {
            const gridCol = doc.createElement('w:gridCol');
            const w = op.colWidths?.[c] ?? Math.floor(9000 / colCount);
            gridCol.setAttribute('w:w', String(w));
            tblGrid.appendChild(gridCol);
        }
        tbl.appendChild(tblGrid);
    }

    // Header row (optional)
    if (op.headers && op.headers.length > 0) {
        tbl.appendChild(buildRow(doc, op.headers, true, op.colWidths));
    }

    // Data rows
    for (const row of op.rows) {
        tbl.appendChild(buildRow(doc, row, false, op.colWidths));
    }

    return tbl;
}

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
