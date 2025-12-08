/**
 * PDF File Handler
 * Implements FileHandler interface for PDF documents
 */

import fs from 'fs/promises';
import { FileHandler, FileResult, FileInfo, ReadOptions, EditResult } from './base.js';
import { parsePdfToMarkdown, parseMarkdownToPdf, editPdf } from '../../tools/pdf/index.js';

/**
 * File handler for PDF documents
 * Extracts text and images, supports page-based pagination
 */
export class PdfFileHandler implements FileHandler {
    private readonly extensions = ['.pdf'];

    /**
     * Check if this handler can handle the given file
     */
    canHandle(path: string): boolean {
        const ext = path.toLowerCase();
        return this.extensions.some(e => ext.endsWith(e));
    }

    /**
     * Read PDF content - extracts text as markdown with images
     */
    async read(path: string, options?: ReadOptions): Promise<FileResult> {
        const { offset = 0, length } = options ?? {};

        try {
            // Use existing PDF parser
            // Ensure we pass a valid PageRange or number array
            // If length is undefined, we assume "rest of file" which requires careful handling.
            // If length is defined, we pass { offset, length }.
            // If neither, we pass empty array (all pages).
            // Note: offset defaults to 0 if undefined.
            
            let range: any;
            if (length !== undefined) {
                range = { offset, length };
            } else if (offset > 0) {
                 // If offset provided but no length, try to read reasonable amount or all?
                 // PageRange requires length. Let's assume 0 means "all" or use a large number?
                 // Looking at pdf2md implementation, it uses generatePageNumbers(offset, length, total).
                 // We'll pass 0 for length to imply "rest" if supported, or just undefined length if valid.
                 // But typescript requires length.
                 range = { offset, length: 0 }; 
            } else {
                range = [];
            }

            const pdfResult = await parsePdfToMarkdown(path, range);

            return {
                content: '', // Main content is in metadata.pages
                mimeType: 'application/pdf',
                metadata: {
                    isPdf: true,
                    author: pdfResult.metadata.author,
                    title: pdfResult.metadata.title,
                    totalPages: pdfResult.metadata.totalPages,
                    pages: pdfResult.pages
                }
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: `Error reading PDF: ${errorMessage}`,
                mimeType: 'text/plain',
                metadata: {
                    error: true,
                    errorMessage
                }
            };
        }
    }

    /**
     * Write PDF - creates from markdown or operations
     */
    async write(path: string, content: any, mode?: 'rewrite' | 'append'): Promise<void> {
        // If content is string, treat as markdown to convert
        if (typeof content === 'string') {
            await parseMarkdownToPdf(content, path);
        } else if (Array.isArray(content)) {
            // Array of operations - use editPdf
            const resultBuffer = await editPdf(path, content);
            await fs.writeFile(path, resultBuffer);
        } else {
            throw new Error('PDF write requires markdown string or array of operations');
        }
    }

    /**
     * Edit PDF by range/operations
     */
    async editRange(path: string, range: string, content: any, options?: Record<string, any>): Promise<EditResult> {
        try {
            // For PDF, range editing isn't directly supported
            // Could interpret range as page numbers in future
            const resultBuffer = await editPdf(path, content);
            await fs.writeFile(options?.outputPath || path, resultBuffer);
            return { success: true, editsApplied: 1 };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                success: false,
                editsApplied: 0,
                errors: [{ location: range, error: errorMessage }]
            };
        }
    }

    /**
     * Get PDF file information
     */
    async getInfo(path: string): Promise<FileInfo> {
        const stats = await fs.stat(path);

        // Get basic PDF metadata
        let metadata: any = { isPdf: true };
        try {
            const pdfResult = await parsePdfToMarkdown(path, { offset: 0, length: 0 }); // Just metadata
            metadata = {
                isPdf: true,
                title: pdfResult.metadata.title,
                author: pdfResult.metadata.author,
                totalPages: pdfResult.metadata.totalPages
            };
        } catch {
            // If we can't parse, just return basic info
        }

        return {
            size: stats.size,
            created: stats.birthtime,
            modified: stats.mtime,
            accessed: stats.atime,
            isDirectory: false,
            isFile: true,
            permissions: (stats.mode & 0o777).toString(8),
            fileType: 'binary',
            metadata
        };
    }
}
