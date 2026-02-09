/**
 * DOCX File Handler
 * Implements FileHandler interface for DOCX documents
 * Handles reading, writing, and modifying DOCX files while preserving formatting
 */

import fs from 'fs/promises';
import { FileHandler, FileResult, FileInfo, ReadOptions, EditResult } from './base.js';
import { readDocx, getDocxMetadata, modifyDocxContent, writeDocx } from '../../tools/docx/index.js';
import type { DocxModification } from '../../tools/docx/types.js';

/**
 * File handler for DOCX documents
 * Extracts text and metadata, supports paragraph-based pagination
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
     * Read DOCX content - returns body XML for LLM modification
     */
    async read(path: string, options?: ReadOptions): Promise<FileResult> {
        const { offset = 0, length } = options ?? {};

        try {
            const result = await readDocx(path, {
                offset,
                length
            });

            // Return body XML as content - LLMs can modify this and write it back
            return {
                content: result.bodyXml,
                mimeType: 'application/xml',
                metadata: {
                    isDocx: true,
                    author: result.metadata.author,
                    title: result.metadata.title,
                    subject: result.metadata.subject,
                    creator: result.metadata.creator,
                    paragraphCount: result.metadata.paragraphCount,
                    wordCount: result.metadata.wordCount,
                    paragraphs: result.paragraphs,
                    // Include extracted text for reference
                    extractedText: result.text
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
     * Write DOCX - NOT SUPPORTED via write_file
     * Use write_docx tool instead to preserve styles
     */
    async write(path: string, content: any, mode?: 'rewrite' | 'append'): Promise<void> {
        throw new Error(
            'DOCX files cannot be written using write_file tool. ' +
            'Use write_docx tool instead to create or modify DOCX files while preserving styles and formatting.'
        );
    }

    /**
     * Edit DOCX by applying modifications
     */
    async editRange(
        path: string,
        range: string,
        content: any,
        options?: Record<string, any>
    ): Promise<EditResult> {
        try {
            // Parse content as modifications
            let modifications: DocxModification[] = [];
            
            if (Array.isArray(content)) {
                modifications = content;
            } else if (typeof content === 'string') {
                // Try to parse as JSON
                try {
                    modifications = JSON.parse(content);
                } catch {
                    // If not JSON, treat as single replace operation
                    modifications = [{
                        type: 'replace',
                        findText: range,
                        replaceText: content
                    }];
                }
            }

            const outputPath = options?.outputPath || path;
            await modifyDocxContent(path, outputPath, modifications);

            return {
                success: true,
                editsApplied: modifications.length
            };
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
     * Get DOCX file information
     */
    async getInfo(path: string): Promise<FileInfo> {
        const stats = await fs.stat(path);

        // Get DOCX metadata
        let metadata: any = { isDocx: true };
        try {
            const docxMetadata = await getDocxMetadata(path);
            metadata = {
                isDocx: true,
                title: docxMetadata.title,
                author: docxMetadata.author,
                subject: docxMetadata.subject,
                creator: docxMetadata.creator,
                paragraphCount: docxMetadata.paragraphCount,
                wordCount: docxMetadata.wordCount
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

