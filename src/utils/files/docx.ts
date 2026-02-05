/**
 * DOCX File Handler
 * Implements FileHandler interface for Microsoft Word documents
 */

import fs from 'fs/promises';
import path from 'path';
import { FileHandler, FileResult, FileInfo, ReadOptions, EditResult } from './base.js';
import {
    parseDocxToMarkdown,
    type DocxParseResult,
    createDocxFromMarkdown,
    editDocxWithOperations,
    type DocxOperation,
    DocxError
} from '../../tools/docx/index.js';

/**
 * File handler for DOCX documents
 * Extracts text as markdown with embedded images
 */
export class DocxFileHandler implements FileHandler {
    private readonly extensions = ['.docx'];

    /**
     * Check if this handler can handle the given file
     */
    canHandle(path: string): boolean {
        const ext = path.toLowerCase();
        return this.extensions.some(e => ext.endsWith(e));
    }

    /**
     * Read DOCX content - extracts text as markdown with images
     */
    async read(path: string, options?: ReadOptions): Promise<FileResult> {
        try {
            // Parse DOCX to markdown
            const docxResult: DocxParseResult = await parseDocxToMarkdown(path, {
                includeImages: true,
                preserveFormatting: true
            });

            // Format the content for MCP response
            let content = docxResult.markdown;

            // Add status message if requested (default: true)
            const includeStatusMessage = options?.includeStatusMessage !== false;
            if (includeStatusMessage) {
                const statusParts: string[] = [];
                
                if (docxResult.metadata.title) {
                    statusParts.push(`Title: "${docxResult.metadata.title}"`);
                }
                if (docxResult.metadata.author) {
                    statusParts.push(`Author: ${docxResult.metadata.author}`);
                }
                if (docxResult.images.length > 0) {
                    statusParts.push(`${docxResult.images.length} embedded images`);
                }
                if (docxResult.sections) {
                    const headings = docxResult.sections.filter(s => s.type === 'heading').length;
                    statusParts.push(`${headings} headings`);
                }

                if (statusParts.length > 0) {
                    content = `[DOCX: ${statusParts.join(', ')}]\n\n${content}`;
                }
            }

            return {
                content,
                mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                metadata: {
                    isDocx: true,
                    title: docxResult.metadata.title,
                    author: docxResult.metadata.author,
                    subject: docxResult.metadata.subject,
                    description: docxResult.metadata.description,
                    creationDate: docxResult.metadata.creationDate,
                    modificationDate: docxResult.metadata.modificationDate,
                    lastModifiedBy: docxResult.metadata.lastModifiedBy,
                    revision: docxResult.metadata.revision,
                    fileSize: docxResult.metadata.fileSize,
                    images: docxResult.images,
                    sections: docxResult.sections
                }
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: `Error reading DOCX: ${errorMessage}`,
                mimeType: 'text/plain',
                metadata: {
                    error: true,
                    errorMessage
                }
            };
        }
    }

    /**
     * Write DOCX file.
     *
     * Behaviour:
     * - When content is a string:
     *   - mode === 'rewrite' (default): create a new DOCX from markdown content
     *   - mode === 'append': append markdown content to existing DOCX (round-trip)
     * - When content is an array: treat as high-level DocxOperation[] and apply edits
     */
    async write(path: string, content: any, mode: 'rewrite' | 'append' = 'rewrite'): Promise<void> {
        const baseDir = path ? this.getBaseDir(path) : process.cwd();

        // String content → treat as markdown
        if (typeof content === 'string') {
            if (mode === 'append') {
                // Append markdown to existing document via operations
                const operations: DocxOperation[] = [{
                    type: 'appendMarkdown',
                    markdown: content
                }];
                const buffer = await editDocxWithOperations(path, operations, { baseDir });
                await fs.writeFile(path, buffer);
            } else {
                // Create a brand new DOCX from markdown
                const buffer = await createDocxFromMarkdown(content, { baseDir });
                await fs.writeFile(path, buffer);
            }
            return;
        }

        // Array content → treat as DocxOperation[]
        if (Array.isArray(content)) {
            const operations = content as DocxOperation[];
            const buffer = await editDocxWithOperations(path, operations, { baseDir });
            await fs.writeFile(path, buffer);
            return;
        }

        throw new Error('Unsupported content type for DOCX write. Expected markdown string or array of operations.');
    }

    /**
     * Edit DOCX by applying high-level operations.
     *
     * The range parameter is currently advisory only; all edits are applied to
     * the document as a whole via markdown round-tripping.
     */
    async editRange(path: string, range: string, content: any, options?: Record<string, any>): Promise<EditResult> {
        const baseDir = this.getBaseDir(path);
        const outputPath = options?.outputPath || path;

        let operations: DocxOperation[];

        if (typeof content === 'string') {
            // Treat string content as markdown to append
            operations = [{
                type: 'appendMarkdown',
                markdown: content
            }];
        } else if (Array.isArray(content)) {
            operations = content as DocxOperation[];
        } else {
            return {
                success: false,
                editsApplied: 0,
                errors: [{
                    location: range,
                    error: 'Unsupported content type for DOCX edit. Expected markdown string or array of operations.'
                }]
            };
        }

        try {
            const buffer = await editDocxWithOperations(path, operations, { baseDir, outputPath });
            await fs.writeFile(outputPath, buffer);

            return {
                success: true,
                editsApplied: operations.length
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                success: false,
                editsApplied: 0,
                errors: [{
                    location: range,
                    error: errorMessage
                }]
            };
        }
    }

    /**
     * Get DOCX file information including metadata
     * 
     * @param path - Path to the DOCX file
     * @returns FileInfo with size, dates, permissions, and DOCX-specific metadata
     */
    async getInfo(path: string): Promise<FileInfo> {
        try {
            const stats = await fs.stat(path);

            // Get basic DOCX metadata
            let metadata: any = { isDocx: true };
            
            try {
                const docxResult = await parseDocxToMarkdown(path, {
                    includeImages: false, // Don't extract images for metadata only
                    preserveFormatting: false
                });
                
                metadata = {
                    isDocx: true,
                    title: docxResult.metadata.title,
                    author: docxResult.metadata.author,
                    subject: docxResult.metadata.subject,
                    description: docxResult.metadata.description,
                    creationDate: docxResult.metadata.creationDate,
                    modificationDate: docxResult.metadata.modificationDate,
                    lastModifiedBy: docxResult.metadata.lastModifiedBy,
                    revision: docxResult.metadata.revision,
                    imageCount: docxResult.images.length,
                    sectionCount: docxResult.sections?.length
                };
            } catch (parseError) {
                // If we can't parse, log warning but return basic info
                console.warn(`Could not parse DOCX metadata for ${path}:`, parseError);
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
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new DocxError(
                `Failed to get DOCX file info: ${message}`,
                'GET_INFO_FAILED',
                { path }
            );
        }
    }

    /**
     * Helper to get base directory for resolving relative image paths.
     */
    private getBaseDir(docxPath: string): string {
        try {
            if (!docxPath) return process.cwd();
            return path.dirname(docxPath);
        } catch {
            return process.cwd();
        }
    }
}

