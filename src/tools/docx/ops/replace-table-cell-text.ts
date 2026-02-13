/**
 * Op: replace_table_cell_text
 *
 * Goal: Replace the "logical value" of a cell while preserving layout and styles.
 *
 * Matching strategy (tried in order):
 * 1. Match by full cell text (all paragraphs joined with spaces)
 * 2. Match by first paragraph text only
 *
 * When the caller passes FULL cell text in `from` / `to` (common for LLMs), we
 * interpret the change like this:
 *
 *   from: "<OLD_TITLE> <SUBTITLE ...>"
 *   to:   "<NEW_TITLE> <SUBTITLE ...>"
 *
 * i.e. only the *title* (first paragraph) changed, the rest of the cell content
 * stayed the same. We detect the unchanged suffix and compute NEW_TITLE by
 * stripping that suffix from `to`. Then we only change the first paragraph text,
 * keeping all other paragraphs (subtitle, etc.) exactly as they were.
 *
 * If we cannot safely detect that pattern, we fall back to treating `from`/`to`
 * as simple first‑paragraph values.
 */

import { getAllBodyTables, nodeListToArray, getCellText, getParagraphText, setCellTextPreservingStyles } from '../dom.js';
import type { ReplaceTableCellTextOp, OpResult } from '../types.js';

export function applyReplaceTableCellText(
    body: Element,
    op: ReplaceTableCellTextOp,
): OpResult {
    const target = op.from.trim();

    // Find all logical tables in the body, including those inside SDTs.
    const tables = getAllBodyTables(body);

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
                const cellText = getCellText(cell).trim();

                // Strategy 1: full cell text match — try to detect a "title-only" change
                if (cellText === target) {
                    const paragraphs = cell.getElementsByTagName('w:p');
                    if (paragraphs.length > 0) {
                        const firstP = paragraphs.item(0) as Element;
                        const firstPText = getParagraphText(firstP).trim();

                        // Cell's "suffix" is everything after the first paragraph text
                        const suffixFrom = cellText.slice(firstPText.length).trimStart();

                        const toTrimmed = op.to.trim();
                        let newFirstText = toTrimmed;

                        if (suffixFrom.length > 0 && toTrimmed.endsWith(suffixFrom)) {
                            // Common LLM pattern:
                            //   from: "<OLD_TITLE> <SUFFIX>"
                            //   to:   "<NEW_TITLE> <SUFFIX>"
                            // Extract "<NEW_TITLE>" by removing the unchanged suffix.
                            newFirstText = toTrimmed
                                .slice(0, toTrimmed.length - suffixFrom.length)
                                .trimEnd();
                        }

                        setCellTextPreservingStyles(cell, newFirstText);
                        return { op, status: 'applied', matched: 1 };
                    }
                }

                // Strategy 2: match by first paragraph text only
                const paragraphs = cell.getElementsByTagName('w:p');
                if (paragraphs.length > 0) {
                    const firstP = paragraphs.item(0) as Element;
                    const firstParagraphText = getParagraphText(firstP).trim();
                    if (firstParagraphText === target) {
                        setCellTextPreservingStyles(cell, op.to);
                        return { op, status: 'applied', matched: 1 };
                    }
                }
            }
        }
    }

    return { op, status: 'skipped', matched: 0, reason: 'no_match' };
}

