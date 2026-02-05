/**
 * DOCX Operations Library
 * Exports all DOCX functionality for reading, creating and editing Word documents
 */

export { parseDocxToMarkdown } from './markdown.js';
export type { DocxParseResult, DocxMetadata, DocxSection, DocxImage } from './markdown.js';

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

// Utilities
export {
  isDataUrl,
  isUrl,
  parseDataUrl,
  resolveImagePath,
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
  DocxError,
  withErrorContext,
} from './utils.js';

