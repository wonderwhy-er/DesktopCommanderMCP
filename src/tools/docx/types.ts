/**
 * DOCX Type Definitions
 * Centralized type definitions for DOCX operations
 */

// DOCX library types - using any due to incomplete type definitions
// These are runtime types from the docx library
export type DocxParagraph = any;
export type DocxTable = any;
export type DocxTableRow = any;
export type DocxTableCell = any;
export type DocxTextRun = any;
export type DocxImageRun = any;
export type DocxDocument = any;

/**
 * DOCX element types that can be parsed and preserved
 */
export type DocxElementType = 'paragraph' | 'table' | 'heading';

/**
 * Structured DOCX element
 */
export interface DocxElement {
  type: DocxElementType;
  content: DocxParagraph | DocxTable;
  level?: number; // Only for headings
}

/**
 * Relationship mapping for images and other resources
 */
export interface DocxRelationship {
  target: string;
  type: string;
}

/**
 * Structured DOCX document representation
 */
export interface DocxStructure {
  elements: DocxElement[];
  images: Map<string, Buffer>;
  relationships: Map<string, DocxRelationship>;
}

/**
 * DOCX metadata structure
 */
export interface DocxMetadata {
  title?: string;
  author?: string;
  creator?: string;
  subject?: string;
  description?: string;
  creationDate?: Date;
  modificationDate?: Date;
  lastModifiedBy?: string;
  revision?: string;
  fileSize?: number;
}

/**
 * Embedded image information
 */
export interface DocxImage {
  id: string;
  data: string; // Base64-encoded
  mimeType: string;
  altText?: string;
  originalSize?: number;
}

/**
 * DOCX section/paragraph structure
 */
export interface DocxSection {
  type: 'heading' | 'paragraph' | 'list' | 'table' | 'image';
  content: string;
  level?: number;
  images?: DocxImage[];
}

/**
 * Complete DOCX parse result
 */
export interface DocxParseResult {
  markdown: string;
  metadata: DocxMetadata;
  images: DocxImage[];
  sections?: DocxSection[];
}

/**
 * Options for DOCX creation and editing
 */
export interface DocxBuildOptions {
  baseDir?: string;
  includeImages?: boolean;
  preserveFormatting?: boolean;
}

/**
 * Options for editing existing DOCX files
 */
export interface DocxEditOptions extends DocxBuildOptions {
  outputPath?: string;
}

/**
 * Parsing options for DOCX to markdown conversion
 */
export interface DocxParseOptions {
  includeImages?: boolean;
  preserveFormatting?: boolean;
  styleMap?: string[];
}

/**
 * Image data prepared for DOCX embedding
 */
export interface PreparedImage {
  buffer: Buffer;
  width?: number;
  height?: number;
  altText: string;
  mimeType: string;
}

/**
 * DOCX Operation Types
 */
export interface DocxReplaceTextOperation {
  type: 'replaceText';
  search: string;
  replace: string;
  matchCase?: boolean;
  global?: boolean;
}

export interface DocxAppendMarkdownOperation {
  type: 'appendMarkdown';
  markdown: string;
}

export interface DocxInsertTableOperation {
  type: 'insertTable';
  markdownTable?: string;
  rows?: string[][];
}

export interface DocxInsertImageOperation {
  type: 'insertImage';
  imagePath: string;
  altText?: string;
  width?: number;
  height?: number;
}

export type DocxOperation =
  | DocxReplaceTextOperation
  | DocxAppendMarkdownOperation
  | DocxInsertTableOperation
  | DocxInsertImageOperation;

