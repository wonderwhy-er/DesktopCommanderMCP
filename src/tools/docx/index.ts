/**
 * DOCX Operations Library
 * Main exports for DOCX functionality
 */

// Reading
export { parseDocxToMarkdown } from './markdown.js';
export type {
  DocxParseResult,
  DocxMetadata,
  DocxSection,
  DocxImage,
} from './markdown.js';

// Structure parsing/building
export {
  parseDocxStructure,
  buildDocxFromStructure,
} from './structure.js';
export type {
  DocxElement,
  DocxStructure,
} from './structure.js';

// Creating and editing
export {
  createDocxFromMarkdown,
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
  DocxElementType,
  DocxRelationship,
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
  buildMarkdownTableFromRows,
  parseMarkdownTable,
  getMimeType,
  formatFileSize,
  normalizeLineEndings,
  splitMarkdownLines,
  isDocxPath,
  getFileNameWithoutExtension,
  prepareImageForDocx,
  createImageRun,
} from './utils.js';

export type {
  PreparedImage,
} from './utils.js';

