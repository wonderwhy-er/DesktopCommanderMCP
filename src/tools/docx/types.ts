/**
 * DOCX Type Definitions
 *
 * Centralised type definitions for every DOCX operation in the module.
 *
 * @module docx/types
 */

// ─── Document Defaults ───────────────────────────────────────────────────────

/** Default document-level settings extracted from the original DOCX, used to preserve styles on re-creation. */
export interface DocxDocumentDefaults {
  /** Default font family (e.g. 'Calibri', 'Times New Roman') */
  font: string;
  /** Default font size in points (e.g. 11, 12) */
  fontSize: number;
  /** Page margins in twips (1/20 pt), as used by Word section properties. */
  margins?: {
    top: number;
    right: number;
    bottom: number;
    left: number;
    header?: number;
    footer?: number;
    gutter?: number;
  };
  /** Page orientation, if specified (portrait by default). */
  orientation?: 'portrait' | 'landscape';
}

// ─── Metadata & Structure ────────────────────────────────────────────────────

export interface DocxMetadata {
  title?: string;
  author?: string;
  subject?: string;
  description?: string;
  creationDate?: Date;
  modificationDate?: Date;
  lastModifiedBy?: string;
  revision?: string;
  fileSize?: number;
}

export interface DocxImage {
  id: string;
  /** Base64-encoded image data */
  data: string;
  mimeType: string;
  altText?: string;
  originalSize?: number;
}

export interface DocxSection {
  type: 'heading' | 'paragraph' | 'list' | 'table' | 'image';
  content: string;
  level?: number;
  images?: DocxImage[];
}

// ─── Parse Result ────────────────────────────────────────────────────────────

export interface DocxParseResult {
  html: string;
  metadata: DocxMetadata;
  images: DocxImage[];
  sections?: DocxSection[];
  /** Original document defaults — passed through the pipeline to preserve styles during editing. */
  documentDefaults?: DocxDocumentDefaults;
}

// ─── Options ─────────────────────────────────────────────────────────────────

export interface DocxParseOptions {
  includeImages?: boolean;
  preserveFormatting?: boolean;
  styleMap?: string[];
}

export interface DocxBuildOptions {
  baseDir?: string;
  includeImages?: boolean;
  preserveFormatting?: boolean;
  /** Original document defaults to preserve font/size when converting HTML → DOCX. */
  documentDefaults?: DocxDocumentDefaults;
}

export interface DocxEditOptions extends DocxBuildOptions {
  outputPath?: string;
  styleMap?: string[];
}

// ─── Operations ──────────────────────────────────────────────────────────────

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
  selector?: string;
  position?: 'before' | 'after' | 'inside';
}

export interface DocxInsertImageOperation {
  type: 'insertImage';
  imagePath: string;
  altText?: string;
  width?: number;
  height?: number;
  selector?: string;
  position?: 'before' | 'after' | 'inside';
}

export interface DocxAppendHtmlOperation {
  type: 'appendHtml';
  html: string;
}

export interface DocxInsertHtmlOperation {
  type: 'insertHtml';
  html: string;
  selector?: string;
  position?: 'before' | 'after' | 'inside';
}

export interface DocxReplaceHtmlOperation {
  type: 'replaceHtml';
  selector: string;
  html: string;
  replaceAll?: boolean;
}

export interface DocxUpdateHtmlOperation {
  type: 'updateHtml';
  selector: string;
  html?: string;
  attributes?: Record<string, string>;
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
