/**
 * DOCX Type Definitions
 * Centralized type definitions for DOCX operations
 */


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
  /** Document content as HTML */
  html: string;
  /** Document metadata */
  metadata: DocxMetadata;
  /** Extracted images */
  images: DocxImage[];
  /** Structured sections (optional, for advanced parsing) */
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
 * Parsing options for DOCX to HTML conversion
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

