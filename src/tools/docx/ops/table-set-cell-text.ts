/**
 * Op: table_set_cell_text
 *
 * Set the text content of a specific table cell.
 * Targets by: tableIndex (0-based among w:tbl in body), row, col.
 * Applies minimal text replacement inside the cell's first paragraph.
 */

import { getAllBodyTables, nodeListToArray, setCellTextPreservingStyles } from '../dom.js';
import type { TableSetCellTextOp, OpResult } from '../types.js';

export function applyTableSetCellText(
    body: Element,
    op: TableSetCellTextOp,
): OpResult {
    // Find the n‑th logical table in the body, including tables inside SDTs.
    const tables = getAllBodyTables(body);

    if (op.tableIndex < 0 || op.tableIndex >= tables.length) {
        return { op, status: 'skipped', matched: 0, reason: 'table_not_found' };
    }

    const table = tables[op.tableIndex];

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

    // Replace cell text while preserving ALL styles (colors, bold, italic, etc.)
    setCellTextPreservingStyles(cell, op.text);
    return { op, status: 'applied', matched: 1 };
}

