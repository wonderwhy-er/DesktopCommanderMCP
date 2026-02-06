/**
 * DOCX Operations Library
 * Main exports for DOCX functionality
 */

// Reading - using mammoth for DOCX to HTML conversion
export { parseDocxToHtml } from './html.js';
export type {
  DocxParseResult,
  DocxMetadata,
  DocxSection,
  DocxImage,
} from './html.js';


// Creating and editing - using html-to-docx for HTML to DOCX conversion
export {
  createDocxFromHtml,
  editDocxWithOperations,
} from './operations.js';
export type {
  DocxOperation,
  DocxReplaceTextOperation,
  DocxAppendMarkdownOperation,
  DocxInsertTableOperation,
  DocxInsertImageOperation,
  DocxBuildOptions,
  DocxEditOptions,
} from './operations.js';

// Types
export type {
  DocxParseOptions,
} from './types.js';

// Error handling
export {
  DocxError,
  DocxErrorCode,
  withErrorContext,
  createDocxError,
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
  formatFileSize,
  normalizeLineEndings,
  splitMarkdownLines,
  isDocxPath,
  getFileNameWithoutExtension,
} from './utils.js';

// Converters
export {
  markdownToHtml,
  markdownTableToHtml,
  buildMarkdownTableFromRows,
} from './converters/index.js';

