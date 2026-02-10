/**
 * Op dispatcher — routes each op to its implementation.
 *
 * Open/Closed Principle: adding a new op type requires only
 * a new file + one extra case here; existing ops stay untouched.
 */

import { applyReplaceParagraphTextExact } from './replace-paragraph-text-exact.js';
import { applyReplaceParagraphAtBodyIndex } from './replace-paragraph-at-body-index.js';
import { applySetColorForStyle } from './set-color-for-style.js';
import { applySetColorForParagraphExact } from './set-color-for-paragraph-exact.js';
import type { DocxOp, OpResult } from '../types.js';

/** Apply a single operation to the w:body element. */
export function applyOp(body: Element, op: DocxOp): OpResult {
    switch (op.type) {
        case 'replace_paragraph_text_exact':
            return applyReplaceParagraphTextExact(body, op);
        case 'replace_paragraph_at_body_index':
            return applyReplaceParagraphAtBodyIndex(body, op);
        case 'set_color_for_style':
            return applySetColorForStyle(body, op);
        case 'set_color_for_paragraph_exact':
            return applySetColorForParagraphExact(body, op);
        default:
            return {
                op,
                status: 'skipped',
                matched: 0,
                reason: `unknown_op_type: ${(op as any).type}`,
            };
    }
}

