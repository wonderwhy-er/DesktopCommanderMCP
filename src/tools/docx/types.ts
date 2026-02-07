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
  /** Custom style mapping for DOCX parsing */
  styleMap?: string[];
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
 * DOCX Operation Types
 */

/**
 * Replace text in HTML content
 */
export interface DocxReplaceTextOperation {
  type: 'replaceText';
  search: string;
  replace: string;
  matchCase?: boolean;
  global?: boolean;
}

/**
 * Append markdown content (converted to HTML)
 */
export interface DocxAppendMarkdownOperation {
  type: 'appendMarkdown';
  markdown: string;
}

/**
 * Insert table from markdown or rows array
 */
export interface DocxInsertTableOperation {
  type: 'insertTable';
  markdownTable?: string;
  rows?: string[][];
  /** CSS selector to find the target element for positioning (optional, appends to end if omitted) */
  selector?: string;
  /** Position relative to target: 'before', 'after', 'inside' (default: 'after') */
  position?: 'before' | 'after' | 'inside';
}

/**
 * Insert image into document
 */
export interface DocxInsertImageOperation {
  type: 'insertImage';
  imagePath: string;
  altText?: string;
  width?: number;
  height?: number;
  /** CSS selector to find the target element for positioning (optional, appends to end if omitted) */
  selector?: string;
  /** Position relative to target: 'before', 'after', 'inside' (default: 'after') */
  position?: 'before' | 'after' | 'inside';
}

/**
 * Append HTML content directly
 */
export interface DocxAppendHtmlOperation {
  type: 'appendHtml';
  html: string;
}

/**
 * Insert HTML content at a specific position
 */
export interface DocxInsertHtmlOperation {
  type: 'insertHtml';
  html: string;
  /** CSS selector to find the target element */
  selector?: string;
  /** Position relative to target: 'before', 'after', 'inside' (default: 'after') */
  position?: 'before' | 'after' | 'inside';
}

/**
 * Replace HTML elements/components
 */
export interface DocxReplaceHtmlOperation {
  type: 'replaceHtml';
  /** CSS selector to find elements to replace */
  selector: string;
  /** HTML content to replace with */
  html: string;
  /** Replace all matching elements (default: false, only first match) */
  replaceAll?: boolean;
}

/**
 * Update/modify HTML elements
 */
export interface DocxUpdateHtmlOperation {
  type: 'updateHtml';
  /** CSS selector to find elements to update */
  selector: string;
  /** HTML content to set as innerHTML */
  html?: string;
  /** Attributes to set/update */
  attributes?: Record<string, string>;
  /** Update all matching elements (default: false, only first match) */
  updateAll?: boolean;
}

export type DocxOperation =
  | DocxReplaceTextOperation
  | DocxAppendMarkdownOperation
  | DocxInsertTableOperation
  | DocxInsertImageOperation
  | DocxAppendHtmlOperation
  | DocxInsertHtmlOperation
  | DocxReplaceHtmlOperation
  | DocxUpdateHtmlOperation;
