/**
 * Op: replace_table_cell_text
 *
 * Find a table cell whose full text content (all paragraphs joined) matches `from`,
 * and replace it with `to`.
 *
 * This operation searches through all tables in the document and finds the first
 * cell whose text matches. It replaces the text in the first paragraph of that cell.
 *
 * This is useful when you've read table content using readDocxOutline and want to
 * replace specific cell values by their text content.
 */

import { getBodyChildren, nodeListToArray, getCellText, setParagraphTextMinimal } from '../dom.js';
import type { ReplaceTableCellTextOp, OpResult } from '../types.js';

export function applyReplaceTableCellText(
    body: Element,
    op: ReplaceTableCellTextOp,
): OpResult {
    const children = getBodyChildren(body);
    const target = op.from.trim();

    // Find all tables
    const tables: Element[] = [];
    for (const child of children) {
        if (child.nodeName === 'w:tbl') {
            tables.push(child);
        }
    }

    // Search through all tables
    for (const table of tables) {
        // Get all rows
        const rows: Element[] = [];
        for (const child of nodeListToArray(table.childNodes)) {
            if (child.nodeType === 1 && (child as Element).nodeName === 'w:tr') {
                rows.push(child as Element);
            }
        }

        // Search through all cells in all rows
        for (const row of rows) {
            const cells: Element[] = [];
            for (const child of nodeListToArray(row.childNodes)) {
                if (child.nodeType === 1 && (child as Element).nodeName === 'w:tc') {
                    cells.push(child as Element);
                }
            }

            for (const cell of cells) {
                // Get full cell text (all paragraphs joined)
                const cellText = getCellText(cell).trim();

                if (cellText === target) {
                    // Find first paragraph in cell and replace its text
                    const paragraphs = cell.getElementsByTagName('w:p');
                    if (paragraphs.length > 0) {
                        const firstP = paragraphs.item(0) as Element;
                        setParagraphTextMinimal(firstP, op.to);

                        // Clear other paragraphs in the cell (optional - keeps cell structure)
                        for (let i = 1; i < paragraphs.length; i++) {
                            const p = paragraphs.item(i) as Element;
                            const tNodes = p.getElementsByTagName('w:t');
                            for (let j = 0; j < tNodes.length; j++) {
                                tNodes.item(j)!.textContent = '';
                            }
                        }

                        return { op, status: 'applied', matched: 1 };
                    } else {
                        // Cell has no paragraphs - create one
                        const doc = cell.ownerDocument;
                        if (!doc) continue;

                        const p = doc.createElement('w:p');
                        const r = doc.createElement('w:r');
                        const t = doc.createElement('w:t');
                        t.setAttribute('xml:space', 'preserve');
                        t.textContent = op.to;
                        r.appendChild(t);
                        p.appendChild(r);
                        cell.appendChild(p);

                        return { op, status: 'applied', matched: 1 };
                    }
                }
            }
        }
    }

    return { op, status: 'skipped', matched: 0, reason: 'no_match' };
}

