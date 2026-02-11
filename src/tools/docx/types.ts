/**
 * Type definitions for DOCX operations.
 * Single source of truth for every type used across the DOCX module.
 */

// ═══════════════════════════════════════════════════════════════════════
// Core document metadata (legacy read path)
// ═══════════════════════════════════════════════════════════════════════

export interface DocxMetadata {
    title?: string;
    author?: string;
    subject?: string;
    creator?: string;
    paragraphCount: number;
    wordCount: number;
}

export interface DocxParagraph {
    index: number;
    text: string;
    hasText: boolean;
}

export interface DocxRun {
    text: string;
    bold?: boolean;
    italic?: boolean;
    color?: string;
    fontSize?: number;
    fontName?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// Legacy modification operations (write_file / edit_block)
// ═══════════════════════════════════════════════════════════════════════

export interface DocxModification {
    type: 'replace' | 'insert' | 'delete' | 'style';
    paragraphIndex?: number;
    findText?: string;
    replaceText?: string;
    insertText?: string;
    style?: {
        color?: string;
        bold?: boolean;
        italic?: boolean;
    };
}

// ═══════════════════════════════════════════════════════════════════════
// Read outline (used by read_docx tool)
// ═══════════════════════════════════════════════════════════════════════

export interface ParagraphOutline {
    bodyChildIndex: number;
    paragraphIndex: number;
    style: string | null;
    text: string;
}

export interface ReadDocxResult {
    path: string;
    paragraphs: ParagraphOutline[];
    stylesSeen: string[];
    counts: {
        tables: number;
        images: number;
        bodyChildren: number;
    };
}

// ═══════════════════════════════════════════════════════════════════════
// Write / patch result (used by write_docx tool)
// ═══════════════════════════════════════════════════════════════════════

export interface WriteDocxStats {
    tablesBefore: number;
    tablesAfter: number;
    bodyChildrenBefore: number;
    bodyChildrenAfter: number;
    bodySignatureBefore: string;
    bodySignatureAfter: string;
}

export interface WriteDocxResult {
    outputPath: string;
    results: OpResult[];
    stats: WriteDocxStats;
    warnings: string[];
}

// ═══════════════════════════════════════════════════════════════════════
// Validation snapshot
// ═══════════════════════════════════════════════════════════════════════

export interface BodySnapshot {
    bodyChildCount: number;
    tableCount: number;
    signature: string;
}

// ═══════════════════════════════════════════════════════════════════════
// Patch operations — original 4
// ═══════════════════════════════════════════════════════════════════════

export interface ReplaceParagraphTextExactOp {
    type: 'replace_paragraph_text_exact';
    from: string;
    to: string;
}

export interface ReplaceParagraphAtBodyIndexOp {
    type: 'replace_paragraph_at_body_index';
    bodyChildIndex: number;
    to: string;
}

export interface SetColorForStyleOp {
    type: 'set_color_for_style';
    style: string;
    color: string;
}

export interface SetColorForParagraphExactOp {
    type: 'set_color_for_paragraph_exact';
    text: string;
    color: string;
}

// ═══════════════════════════════════════════════════════════════════════
// Patch operations — new 6
// ═══════════════════════════════════════════════════════════════════════

export interface SetParagraphStyleAtBodyIndexOp {
    type: 'set_paragraph_style_at_body_index';
    bodyChildIndex: number;
    style: string;
}

export interface InsertParagraphAfterTextOp {
    type: 'insert_paragraph_after_text';
    after: string;
    text: string;
    style?: string;
}

export interface DeleteParagraphAtBodyIndexOp {
    type: 'delete_paragraph_at_body_index';
    bodyChildIndex: number;
}

export interface TableSetCellTextOp {
    type: 'table_set_cell_text';
    tableIndex: number;
    row: number;
    col: number;
    text: string;
}

export interface ReplaceHyperlinkUrlOp {
    type: 'replace_hyperlink_url';
    oldUrl: string;
    newUrl: string;
}

export interface HeaderReplaceTextExactOp {
    type: 'header_replace_text_exact';
    from: string;
    to: string;
}

// ═══════════════════════════════════════════════════════════════════════
// Discriminated union + result
// ═══════════════════════════════════════════════════════════════════════

export type DocxOp =
    | ReplaceParagraphTextExactOp
    | ReplaceParagraphAtBodyIndexOp
    | SetColorForStyleOp
    | SetColorForParagraphExactOp
    | SetParagraphStyleAtBodyIndexOp
    | InsertParagraphAfterTextOp
    | DeleteParagraphAtBodyIndexOp
    | TableSetCellTextOp
    | ReplaceHyperlinkUrlOp
    | HeaderReplaceTextExactOp;

export interface OpResult {
    op: DocxOp;
    status: 'applied' | 'skipped';
    matched: number;
    reason?: string;
}
