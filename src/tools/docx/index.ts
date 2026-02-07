/**
 * DOCX Operations Library
 * Main exports for DOCX functionality
 */

// Reading - direct DOCX XML parsing with mammoth.js fallback
export { parseDocxToHtml } from './html.js';
export { convertDocxToStyledHtml } from './styled-html-parser.js';
export type {
  DocxParseResult,
  DocxMetadata,
  DocxSection,
  DocxImage,
} from './html.js';


// Creating and editing - using html-to-docx for HTML to DOCX conversion
export { createDocxFromHtml } from './builders/html-builder.js';
export { editDocxWithOperations } from './operations/index.js';
export type {
  DocxOperation,
  DocxReplaceTextOperation,
  DocxAppendMarkdownOperation,
  DocxInsertTableOperation,
  DocxInsertImageOperation,
  DocxAppendHtmlOperation,
  DocxInsertHtmlOperation,
  DocxReplaceHtmlOperation,
  DocxUpdateHtmlOperation,
  DocxBuildOptions,
  DocxEditOptions,
} from './types.js';

// Types
export type {
  DocxParseOptions,
} from './types.js';

// Error handling
export {
  DocxError,
  DocxErrorCode,
  withErrorContext,
} from './errors.js';

// Utilities
export {
  isDataUrl,
  isUrl,
  parseDataUrl,
  resolveImagePath,
  fileExists,
  validateImageFile,
  escapeRegExp,
  isValidMarkdownTable,
  parseMarkdownTable,
  getMimeType,
  isDocxPath,
} from './utils.js';

// Validators
export {
  validateDocxPath,
  validateOperations,
  validateHtml,
  validateSelector,
  validateImageDimensions,
} from './validators.js';

// Converters
export {
  markdownToHtml,
  markdownTableToHtml,
  buildMarkdownTableFromRows,
} from './converters/index.js';

