/**
 * DOCX Operations Library — Public API
 *
 * Only the symbols that external consumers actually import are re-exported here.
 * Internal helpers (styled-html-parser, validators, converters, etc.) are
 * consumed directly by sibling modules and are NOT part of the public surface.
 */

// ── Reading ─────────────────────────────────────────────────────────────────
export { parseDocxToHtml } from './html.js';

// ── Writing / Editing ───────────────────────────────────────────────────────
export { createDocxFromHtml } from './builders/html-builder.js';
export { editDocxWithOperations } from './operations/index.js';

// ── Types ───────────────────────────────────────────────────────────────────
export type {
  DocxParseResult,
  DocxMetadata,
  DocxImage,
  DocxSection,
  DocxOperation,
} from './types.js';

// ── Errors ──────────────────────────────────────────────────────────────────
export { DocxError, DocxErrorCode } from './errors.js';
