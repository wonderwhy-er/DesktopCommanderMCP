/**
 * Op: table_set_cell_text
 *
 * Set the text content of a specific table cell.
 * Targets by: tableIndex (0-based among w:tbl in body), row, col.
 * Applies minimal text replacement inside the cell's first paragraph.
 */

import { getBodyChildren, nodeListToArray, setParagraphTextMinimal } from '../dom.js';
import type { TableSetCellTextOp, OpResult } from '../types.js';

export function applyTableSetCellText(
    body: Element,
    op: TableSetCellTextOp,
): OpResult {
    const children = getBodyChildren(body);

    // Find the n-th w:tbl
    let tableCount = 0;
    let table: Element | null = null;
    for (const child of children) {
        if (child.nodeName === 'w:tbl') {
            if (tableCount === op.tableIndex) {
                table = child;
                break;
            }
            tableCount++;
        }
    }

    if (!table) {
        return { op, status: 'skipped', matched: 0, reason: 'table_not_found' };
    }

    // Find the n-th w:tr
    const rows: Element[] = [];
    for (const child of nodeListToArray(table.childNodes)) {
        if (child.nodeType === 1 && (child as Element).nodeName === 'w:tr') {
            rows.push(child as Element);
        }
    }

    if (op.row < 0 || op.row >= rows.length) {
        return { op, status: 'skipped', matched: 0, reason: 'row_out_of_range' };
    }

    // Find the n-th w:tc in the row
    const cells: Element[] = [];
    for (const child of nodeListToArray(rows[op.row].childNodes)) {
        if (child.nodeType === 1 && (child as Element).nodeName === 'w:tc') {
            cells.push(child as Element);
        }
    }

    if (op.col < 0 || op.col >= cells.length) {
        return { op, status: 'skipped', matched: 0, reason: 'col_out_of_range' };
    }

    const cell = cells[op.col];

    // Find first w:p inside the cell and apply minimal text replacement
    for (const child of nodeListToArray(cell.childNodes)) {
        if (child.nodeType === 1 && (child as Element).nodeName === 'w:p') {
            const p = child as Element;
            const tNodes = p.getElementsByTagName('w:t');

            if (tNodes.length > 0) {
                // Existing runs — use minimal replacement
                setParagraphTextMinimal(p, op.text);
            } else {
                // Empty cell — create a run
                const doc = cell.ownerDocument;
                if (!doc) return { op, status: 'skipped', matched: 0, reason: 'no_owner_document' };

                const r = doc.createElement('w:r');
                const t = doc.createElement('w:t');
                t.setAttribute('xml:space', 'preserve');
                t.textContent = op.text;
                r.appendChild(t);
                p.appendChild(r);
            }

            return { op, status: 'applied', matched: 1 };
        }
    }

    return { op, status: 'skipped', matched: 0, reason: 'no_paragraph_in_cell' };
}

