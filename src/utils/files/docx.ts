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
     * Read DOCX content - extracts text as HTML with images
     */
    async read(path: string, options?: ReadOptions): Promise<FileResult> {
        try {
            // Parse DOCX to HTML using mammoth
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
     * Generate a versioned filename for DOCX files to preserve originals
     * @param filePath Original file path
     * @returns Versioned filename (e.g., document_v1.docx, document_v2.docx)
     */
    private async generateVersionedPath(filePath: string): Promise<string> {
        const dir = path.dirname(filePath);
        const ext = path.extname(filePath);
        const baseName = path.basename(filePath, ext);
        
        // Try to find the next available version number
        let version = 1;
        let versionedPath: string;
        
        do {
            versionedPath = path.join(dir, `${baseName}_v${version}${ext}`);
            try {
                await fs.access(versionedPath);
                // File exists, try next version
                version++;
            } catch {
                // File doesn't exist, we can use this version
                break;
            }
        } while (version < 1000); // Safety limit
        
        return versionedPath;
    }

    /**
     * Write DOCX file.
     *
     * Behaviour:
     * - When content is a string:
     *   - mode === 'rewrite' (default): create a new DOCX from HTML content
     *   - mode === 'append': append HTML content to existing DOCX (creates versioned file)
     * - When content is an array: treat as high-level DocxOperation[] and apply edits (creates versioned file)
     * 
     * When modifying existing files, automatically creates a versioned copy to preserve the original.
     */
    async write(path: string, content: any, mode: 'rewrite' | 'append' = 'rewrite'): Promise<void> {
        const baseDir = path ? this.getBaseDir(path) : process.cwd();

        // String content → treat as HTML (or markdown which will be converted)
        if (typeof content === 'string') {
            if (mode === 'append') {
                // Append HTML/markdown to existing document via operations
                // Check if file exists - if so, create versioned copy
                let targetPath = path;
                try {
                    await fs.access(path);
                    // File exists, create versioned copy
                    targetPath = await this.generateVersionedPath(path);
                } catch {
                    // File doesn't exist, create new file
                }
                
                const operations: DocxOperation[] = [{
                    type: 'appendMarkdown',
                    markdown: content // Will be converted to HTML internally
                }];
                const buffer = await editDocxWithOperations(path, operations, { baseDir });
                await fs.writeFile(targetPath, buffer);
            } else {
                // Create a brand new DOCX from HTML
                // If content looks like markdown, convert it to HTML first
                const html = this.convertToHtmlIfNeeded(content);
                const buffer = await createDocxFromHtml(html, { baseDir });
                await fs.writeFile(path, buffer);
            }
            return;
        }

        // Array content → treat as DocxOperation[]
        if (Array.isArray(content)) {
            // Check if file exists - if so, create versioned copy
            let targetPath = path;
            try {
                await fs.access(path);
                // File exists, create versioned copy to preserve original
                targetPath = await this.generateVersionedPath(path);
            } catch {
                throw new Error(`Cannot modify DOCX: source file does not exist: ${path}. Use string content to create a new DOCX file.`);
            }
            
            const operations = content as DocxOperation[];
            const buffer = await editDocxWithOperations(path, operations, { baseDir });
            await fs.writeFile(targetPath, buffer);
            return;
        }

        throw new Error('Unsupported content type for DOCX write. Expected HTML/markdown string or array of operations.');
    }

    /**
     * Edit DOCX by applying high-level operations.
     *
     * The range parameter is currently advisory only; all edits are applied to
     * the document as a whole via markdown round-tripping.
     * 
     * Automatically creates a versioned copy to preserve the original file.
     */
    async editRange(path: string, range: string, content: any, options?: Record<string, any>): Promise<EditResult> {
        const baseDir = this.getBaseDir(path);
        
        // Determine output path: use provided outputPath, otherwise create versioned file
        let outputPath: string;
        if (options?.outputPath) {
            outputPath = options.outputPath;
        } else {
            // Check if file exists - if so, create versioned copy
            try {
                await fs.access(path);
                // File exists, create versioned copy to preserve original
                outputPath = await this.generateVersionedPath(path);
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
                const docxResult = await parseDocxToHtml(path, {
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

    /**
     * Convert markdown to HTML if needed, otherwise return HTML as-is
     */
    private convertToHtmlIfNeeded(content: string): string {
        // Simple heuristic: if content has markdown patterns but no HTML tags, convert it
        const hasMarkdown = /^#{1,6}\s|^\*\*|^\[.*\]\(|^\|.*\|/.test(content);
        const hasHtmlTags = /<[a-z][\s\S]*>/i.test(content);
        
        if (hasMarkdown && !hasHtmlTags) {
            // Convert markdown to HTML
            let html = content;
            // Headings
            html = html.replace(/^### (.*)$/gm, '<h3>$1</h3>');
            html = html.replace(/^## (.*)$/gm, '<h2>$1</h2>');
            html = html.replace(/^# (.*)$/gm, '<h1>$1</h1>');
            // Bold
            html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
            // Italic
            html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
            // Images
            html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" />');
            // Links
            html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
            // Paragraphs
            html = html.split('\n\n').map(p => p.trim()).filter(p => p).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('\n');
            return html;
        }
        
        return content;
    }
}

