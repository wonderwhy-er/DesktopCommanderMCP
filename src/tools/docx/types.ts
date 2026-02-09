/**
 * Type definitions for DOCX operations
 */

/**
 * DOCX metadata extracted from document
 */
export interface DocxMetadata {
    /** Document title (from core properties) */
    title?: string;
    /** Document author (from core properties) */
    author?: string;
    /** Document subject (from core properties) */
    subject?: string;
    /** Document creator (from core properties) */
    creator?: string;
    /** Total number of paragraphs in document */
    paragraphCount: number;
    /** Total word count (approximate) */
    wordCount: number;
}

/**
 * Represents a paragraph in a DOCX document
 */
export interface DocxParagraph {
    /** Paragraph index (0-based) */
    index: number;
    /** Plain text content of paragraph */
    text: string;
    /** Whether paragraph contains text */
    hasText: boolean;
}

/**
 * Represents a text run (formatted text segment) in a DOCX document
 */
export interface DocxRun {
    /** Text content of the run */
    text: string;
    /** Whether run has bold formatting */
    bold?: boolean;
    /** Whether run has italic formatting */
    italic?: boolean;
    /** Font color (hex format, e.g., "FF0000") */
    color?: string;
    /** Font size (in half-points) */
    fontSize?: number;
    /** Font name */
    fontName?: string;
}

/**
 * Modification operation for DOCX content
 */
export interface DocxModification {
    /** Type of modification */
    type: 'replace' | 'insert' | 'delete' | 'style';
    /** Target paragraph index (0-based) */
    paragraphIndex?: number;
    /** Text to find (for replace operations) */
    findText?: string;
    /** Text to replace with */
    replaceText?: string;
    /** Text to insert */
    insertText?: string;
    /** Style options for text */
    style?: {
        /** Font color (hex format) */
        color?: string;
        /** Bold formatting */
        bold?: boolean;
        /** Italic formatting */
        italic?: boolean;
    };
}

