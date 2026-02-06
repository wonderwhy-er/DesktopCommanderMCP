/**
 * DOCX Creation and Editing Operations
 * 
 * Main entry point for DOCX operations. This module provides:
 * - Creating DOCX files from HTML
 * - Editing existing DOCX files via operations
 * 
 * @module docx/operations
 */

import type { DocxBuildOptions, DocxEditOptions, DocxOperation } from './types.js';
import { createDocxFromHtml } from './builders/html-builder.js';
import { editDocxWithOperations } from './operations/index.js';

// Re-export types
export type {
  DocxBuildOptions,
  DocxEditOptions,
  DocxOperation,
  DocxReplaceTextOperation,
  DocxAppendMarkdownOperation,
  DocxInsertTableOperation,
  DocxInsertImageOperation,
} from './types.js';

// Re-export main functions
export { createDocxFromHtml, editDocxWithOperations };
