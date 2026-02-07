/**
 * DOCX File Handler
 * Implements FileHandler interface for Microsoft Word documents
 */

import fs from 'fs/promises';
import path from 'path';
import { FileHandler, FileResult, FileInfo, ReadOptions, EditResult } from './base.js';
import {
    parseDocxToHtml,
    type DocxParseResult,
    createDocxFromHtml,
    editDocxWithOperations,
    type DocxOperation,
    DocxError
} from '../../tools/docx/index.js';
import { convertToHtmlIfNeeded, generateOutputPath } from '../../tools/docx/utils.js';

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
     * Read DOCX content — extracts text as styled HTML (with embedded images).
     * Uses direct DOCX XML parsing for style preservation, with mammoth.js fallback.
     */
    async read(path: string, options?: ReadOptions): Promise<FileResult> {
        try {
            const docxResult: DocxParseResult = await parseDocxToHtml(path, {
                includeImages: true,
                preserveFormatting: true
            });

            // Format the content for MCP response
            let content = docxResult.html;

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
     * - String content + 'rewrite': create new DOCX from HTML/markdown.
     * - String content + 'append': append to existing DOCX → writes to {name}_v1.docx.
     * - Array content: apply DocxOperation[] edits → writes to {name}_v1.docx.
     * Original file is always preserved.
     */
    async write(path: string, content: any, mode: 'rewrite' | 'append' = 'rewrite'): Promise<void> {
        const baseDir = path ? this.getBaseDir(path) : process.cwd();

        // String content → treat as HTML (or markdown which will be converted)
        if (typeof content === 'string') {
            if (mode === 'append') {
                // Append HTML/markdown — write to _v1 file, preserve original
                const targetPath = await generateOutputPath(path);
                const operations: DocxOperation[] = [{
                    type: 'appendMarkdown',
                    markdown: content
                }];
                const buffer = await editDocxWithOperations(path, operations, { baseDir });
                await fs.writeFile(targetPath, buffer);
            } else {
                const html = convertToHtmlIfNeeded(content);
                const buffer = await createDocxFromHtml(html, { baseDir });
                await fs.writeFile(path, buffer);
            }
            return;
        }

        // Array content → treat as DocxOperation[], write to _v1 file, preserve original
        if (Array.isArray(content)) {
            try {
                await fs.access(path);
            } catch {
                throw new Error(`Cannot modify DOCX: source file does not exist: ${path}. Use string content to create a new DOCX file.`);
            }
            
            const targetPath = await generateOutputPath(path);
            const operations = content as DocxOperation[];
            const buffer = await editDocxWithOperations(path, operations, { baseDir });
            await fs.writeFile(targetPath, buffer);
            return;
        }

        throw new Error('Unsupported content type for DOCX write. Expected HTML/markdown string or array of operations.');
    }

    /**
     * Edit DOCX by applying high-level operations.
     * Writes to {name}_v1.docx unless `options.outputPath` is provided.
     */
    async editRange(path: string, range: string, content: any, options?: Record<string, any>): Promise<EditResult> {
        const baseDir = this.getBaseDir(path);
        
        // Use provided outputPath, otherwise write to _v1 file
        const outputPath = options?.outputPath ?? await generateOutputPath(path);
        try {
            await fs.access(path);
        } catch {
            return {
                success: false,
                editsApplied: 0,
                errors: [{
                    location: range,
                    error: `Cannot edit DOCX: source file does not exist: ${path}`
                }]
            };
        }

        let operations: DocxOperation[];

        if (typeof content === 'string') {
            // Treat string content as HTML/markdown to append (will be converted to HTML internally)
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
                    error: 'Unsupported content type for DOCX edit. Expected HTML/markdown string or array of operations.'
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
     * Get DOCX file information including metadata.
     */
    async getInfo(path: string): Promise<FileInfo> {
        try {
            const stats = await fs.stat(path);

            let metadata: Record<string, unknown> = { isDocx: true };

            try {
                const docxResult = await parseDocxToHtml(path, {
                    includeImages: false,
                    preserveFormatting: false,
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
                    sectionCount: docxResult.sections?.length,
                };
            } catch {
                // Non-critical — return basic info if parsing fails
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

    /** Get base directory for resolving relative image paths. */
    private getBaseDir(docxPath: string): string {
        return docxPath ? path.dirname(docxPath) : process.cwd();
    }

}

