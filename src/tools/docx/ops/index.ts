/**
 * Op dispatcher — routes each op to its implementation.
 *
 * Open/Closed Principle: adding a new op type requires only
 * a new file + one extra case here; existing ops stay untouched.
 */

import PizZip from 'pizzip';
import { applyReplaceParagraphTextExact } from './replace-paragraph-text-exact.js';
import { applyReplaceParagraphAtBodyIndex } from './replace-paragraph-at-body-index.js';
import { applySetColorForStyle } from './set-color-for-style.js';
import { applySetColorForParagraphExact } from './set-color-for-paragraph-exact.js';
import { applySetParagraphStyleAtBodyIndex } from './set-paragraph-style-at-body-index.js';
import { applyInsertParagraphAfterText } from './insert-paragraph-after-text.js';
import { applyDeleteParagraphAtBodyIndex } from './delete-paragraph-at-body-index.js';
import { applyTableSetCellText } from './table-set-cell-text.js';
import { applyReplaceTableCellText } from './replace-table-cell-text.js';
import { applyReplaceHyperlinkUrl } from './replace-hyperlink-url.js';
import { applyHeaderReplaceTextExact } from './header-replace-text-exact.js';
import { applyInsertTable } from './insert-table-after-text.js';
import { applyInsertImage } from './insert-image-after-text.js';
import type { DocxOp, OpResult } from '../types.js';

/**
 * Apply a single operation.
 *
 * @param body   The w:body element (for DOM-based body ops)
 * @param op     The operation descriptor
 * @param zip    Optional PizZip instance — required for ops that modify
 *               files outside word/document.xml (e.g. hyperlinks, headers)
 */
export function applyOp(body: Element, op: DocxOp, zip?: PizZip): OpResult {
    switch (op.type) {
        case 'replace_paragraph_text_exact':
            return applyReplaceParagraphTextExact(body, op);
        case 'replace_paragraph_at_body_index':
            return applyReplaceParagraphAtBodyIndex(body, op);
        case 'set_color_for_style':
            return applySetColorForStyle(body, op);
        case 'set_color_for_paragraph_exact':
            return applySetColorForParagraphExact(body, op);
        case 'set_paragraph_style_at_body_index':
            return applySetParagraphStyleAtBodyIndex(body, op);
        case 'insert_paragraph_after_text':
            return applyInsertParagraphAfterText(body, op);
        case 'delete_paragraph_at_body_index':
            return applyDeleteParagraphAtBodyIndex(body, op);
        case 'table_set_cell_text':
            return applyTableSetCellText(body, op);
        case 'replace_table_cell_text':
            return applyReplaceTableCellText(body, op);
        case 'replace_hyperlink_url':
            if (!zip) return { op, status: 'skipped', matched: 0, reason: 'zip_required_for_hyperlink_op' };
            return applyReplaceHyperlinkUrl(body, op, zip);
        case 'header_replace_text_exact':
            if (!zip) return { op, status: 'skipped', matched: 0, reason: 'zip_required_for_header_op' };
            return applyHeaderReplaceTextExact(body, op, zip);
        case 'insert_table':
            return applyInsertTable(body, op);
        case 'insert_image':
            if (!zip) return { op, status: 'skipped', matched: 0, reason: 'zip_required_for_image_op' };
            return applyInsertImage(body, op, zip);
        default:
            return {
                op,
                status: 'skipped',
                matched: 0,
                reason: `unknown_op_type: ${(op as any).type}`,
            };
    }
}
