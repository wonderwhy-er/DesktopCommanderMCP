/**
 * Op: replace_paragraph_text_exact
 *
 * Find FIRST paragraph whose trimmed text === `from` **anywhere in the body**,
 * including paragraphs inside table cells, content controls, etc.
 *
 * Replacement behavior:
 * - Replaces the matched paragraph's text while preserving all its run styles
 * - Preserves all other paragraphs in the same cell (if the paragraph is in a table cell)
 * - Preserves paragraph properties (w:pPr) and run properties (w:rPr)
 *
 * This is useful when you want to replace a specific paragraph by its exact text,
 * especially in table cells where you want to replace one paragraph while keeping
 * others intact. For example, replacing "LAWN AND LANDSCAPE" with "EARTH AND MOUNTAIN"
 * in a cell that also contains a subtitle paragraph will preserve the subtitle.
 *
 * Note: For replacing entire cell content (matching by full cell text), use
 * `replace_table_cell_text` instead.
 */

import { getParagraphText, setParagraphTextPreservingStyles, nodeListToArray } from '../dom.js';
import type { ReplaceParagraphTextExactOp, OpResult } from '../types.js';

export function applyReplaceParagraphTextExact(
    body: Element,
    op: ReplaceParagraphTextExactOp,
): OpResult {
    const target = op.from.trim();

    // Traverse **all** paragraphs in the body, not just direct body children.
    // This includes paragraphs inside table cells, content controls, etc.
    const paragraphs = body.getElementsByTagName('w:p');

    for (let i = 0; i < paragraphs.length; i++) {
        const p = paragraphs.item(i) as Element;
        const paragraphText = getParagraphText(p).trim();

        if (paragraphText === target) {
            // Preserve all run styles (colors, bold, italic, etc.) when replacing
            setParagraphTextPreservingStyles(p, op.to);
            return { op, status: 'applied', matched: 1 };
        }
    }

    return { op, status: 'skipped', matched: 0, reason: 'no_match' };
}

