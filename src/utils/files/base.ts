/**
 * Base interfaces and types for file handling system
 * All file handlers implement the FileHandler interface
 */

// ============================================================================
// Core Interfaces
// ============================================================================

/**
 * Base interface that all file handlers must implement
 */
export interface FileHandler {
    /**
     * Read file content
     * @param path Validated file path
     * @param options Read options (offset, length, sheet, etc.)
     * @returns File result with content and metadata
     */
    read(path: string, options?: ReadOptions): Promise<FileResult>;

    /**
     * Write file (complete rewrite or append)
     * @param path Validated file path
     * @param content Content to write
     * @param mode Write mode: 'rewrite' (default) or 'append'
     */
    write(path: string, content: any, mode?: 'rewrite' | 'append'): Promise<void>;

    /**
     * Edit a specific range (bulk rewrite)
     * PRIMARY METHOD for structured file editing (Excel, etc.)
     * Simpler and more powerful than location-based edits
     * Supports:
     * - Cell ranges: "Sheet1!A1:C10" with 2D array content
     * - Whole sheets: "Sheet1" to replace entire sheet
     * - Chunking: Update 1000 rows at a time for large files
     *
     * Currently implemented by: ExcelFileHandler
     * TECHNICAL DEBT: TextFileHandler should also implement this for search/replace
     * (logic currently in src/tools/edit.ts - see comments there)
     *
     * @param path Validated file path
     * @param range Range identifier (e.g., "Sheet1!A1:C10" or "Sheet1")
     * @param content New content for the range (2D array for Excel)
     * @param options Additional format-specific options
     * @returns Result with success status
     */
    editRange?(path: string, range: string, content: any, options?: Record<string, any>): Promise<EditResult>;

    /**
     * Get file metadata
     * @param path Validated file path
     * @returns File information including type-specific metadata
     */
    getInfo(path: string): Promise<FileInfo>;

    /**
     * Check if this handler can handle the given file
     * @param path File path
     * @returns true if this handler supports this file type (can be async for content-based checks)
     */
    canHandle(path: string): boolean | Promise<boolean>;
}

// ============================================================================
// Read Operations
// ============================================================================

/**
 * Options for reading files
 */
export interface ReadOptions {
    /** Whether the path is a URL */
    isUrl?: boolean;

    /** Starting line/row number (for text/excel) */
    offset?: number;

    /** Maximum number of lines/rows to read */
    length?: number;

    /** Excel-specific: Sheet name or index */
    sheet?: string | number;

    /** Excel-specific: Cell range (e.g., "A1:C10") */
    range?: string;

    /** Whether to include status messages (default: true) */
    includeStatusMessage?: boolean;
}

/**
 * Result from reading a file
 */
export interface FileResult {
    /** File content (string for text/csv, Buffer for binary, base64 string for images) */
    content: string | Buffer;

    /** MIME type of the content */
    mimeType: string;

    /** Type-specific metadata */
    metadata?: FileMetadata;
}

/**
 * File-type specific metadata
 */
export interface FileMetadata {
    /** For images */
    isImage?: boolean;

    /** For binary files */
    isBinary?: boolean;

    /** For Excel files */
    isExcelFile?: boolean;
    sheets?: ExcelSheet[];
    fileSize?: number;
    isLargeFile?: boolean;

    /** For text files */
    lineCount?: number;

    /** For PDF files */
    isPdf?: boolean;
    author?: string;
    title?: string;
    totalPages?: number;
    pages?: PdfPageItem[];

    /** Error information if operation failed */
    error?: boolean;
    errorMessage?: string;
}

/**
 * PDF page content item
 */
export interface PdfPageItem {
    pageNumber: number;
    text: string;
    images: Array<{
        data: string;
        mimeType: string;
    }>;
}

/**
 * Excel sheet metadata
 */
export interface ExcelSheet {
    /** Sheet name */
    name: string;

    /** Number of rows in sheet */
    rowCount: number;

    /** Number of columns in sheet */
    colCount: number;
}

// ============================================================================
// Edit Operations
// ============================================================================

/**
 * Result from edit operation (used by editRange)
 */
export interface EditResult {
    /** Whether all edits succeeded */
    success: boolean;

    /** Number of edits successfully applied */
    editsApplied: number;

    /** Errors that occurred during editing */
    errors?: Array<{
        location: string;
        error: string;
    }>;
}

// ============================================================================
// File Information
// ============================================================================

/**
 * File information and metadata
 */
export interface FileInfo {
    /** File size in bytes */
    size: number;

    /** Creation time */
    created: Date;

    /** Last modification time */
    modified: Date;

    /** Last access time */
    accessed: Date;

    /** Is this a directory */
    isDirectory: boolean;

    /** Is this a regular file */
    isFile: boolean;

    /** File permissions (octal string) */
    permissions: string;

    /** File type classification */
    fileType: 'text' | 'excel' | 'image' | 'binary';

    /** Type-specific metadata */
    metadata?: FileMetadata;
}
