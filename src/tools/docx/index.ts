/**
 * DOCX Operations Library — Public API
 *
 * Re-exports only the symbols that external consumers need.
 * Internal modules (styled-html-parser, validators, converters, etc.)
 * are consumed by sibling files and are NOT part of the public surface.
 *
 * @module docx
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
  DocxDocumentDefaults,
} from './types.js';

// ── Errors ──────────────────────────────────────────────────────────────────
export { DocxError, DocxErrorCode } from './errors.js';
