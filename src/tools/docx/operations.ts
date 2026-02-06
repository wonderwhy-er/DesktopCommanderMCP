/**
 * DOCX Creation and Editing Operations
 * 
 * Main entry point for DOCX operations. This module provides:
 * - Creating DOCX files from markdown
 * - Editing existing DOCX files via operations
 * 
 * @module docx/operations
 */

import type { DocxBuildOptions, DocxEditOptions, DocxOperation } from './types.js';
import { createDocxFromMarkdown } from './builders/markdown-builder.js';
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
export { createDocxFromMarkdown, editDocxWithOperations };
