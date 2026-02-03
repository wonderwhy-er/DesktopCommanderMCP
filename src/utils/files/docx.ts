/**
 * DOCX File Handler
 * Implements FileHandler interface for Microsoft Word documents
 */

import fs from 'fs/promises';
import { FileHandler, FileResult, FileInfo, ReadOptions, EditResult } from './base.js';
import { parseDocxToMarkdown, DocxParseResult } from '../../tools/docx/index.js';

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
     * Write DOCX - not implemented yet
     * TODO: Implement DOCX creation using docx library
     */
    async write(path: string, content: any, mode?: 'rewrite' | 'append'): Promise<void> {
        throw new Error('DOCX write operations are not yet implemented. Use markdown or HTML and convert externally.');
    }

    /**
     * Edit DOCX by range/operations - not implemented yet
     * TODO: Implement DOCX editing operations
     */
    async editRange(path: string, range: string, content: any, options?: Record<string, any>): Promise<EditResult> {
        throw new Error('DOCX edit operations are not yet implemented.');
    }

    /**
     * Get DOCX file information
     */
    async getInfo(path: string): Promise<FileInfo> {
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
                creationDate: docxResult.metadata.creationDate,
                modificationDate: docxResult.metadata.modificationDate,
                imageCount: docxResult.images.length,
                sectionCount: docxResult.sections?.length
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

