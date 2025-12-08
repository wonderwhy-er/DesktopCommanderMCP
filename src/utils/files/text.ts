/**
 * Text file handler
 * Handles reading, writing, and editing text files
 *
 * Binary detection is handled at the factory level (factory.ts) using isBinaryFile.
 * This handler only receives files that have been confirmed as text.
 *
 * TECHNICAL DEBT:
 * This handler is missing editRange() - text search/replace logic currently lives in
 * src/tools/edit.ts (performSearchReplace function) instead of here.
 *
 * For architectural consistency with ExcelFileHandler.editRange(), the fuzzy
 * search/replace logic should be moved here. See comment in src/tools/edit.ts.
 */

import fs from "fs/promises";
import path from "path";
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import {
    FileHandler,
    ReadOptions,
    FileResult,
    FileInfo
} from './base.js';

// TODO: Centralize these constants with filesystem.ts to avoid silent drift
// These duplicate concepts from filesystem.ts and should be moved to a shared
// constants module (e.g., src/utils/files/constants.ts) during reorganization
const FILE_SIZE_LIMITS = {
    LARGE_FILE_THRESHOLD: 10 * 1024 * 1024,  // 10MB
    LINE_COUNT_LIMIT: 10 * 1024 * 1024,      // 10MB for line counting
} as const;

const READ_PERFORMANCE_THRESHOLDS = {
    SMALL_READ_THRESHOLD: 100,    // For very small reads
    DEEP_OFFSET_THRESHOLD: 1000,  // For byte estimation
    SAMPLE_SIZE: 10000,           // Sample size for estimation
    CHUNK_SIZE: 8192,             // 8KB chunks for reverse reading
} as const;

/**
 * Text file handler implementation
 * Binary detection is done at the factory level - this handler assumes file is text
 */
export class TextFileHandler implements FileHandler {
    canHandle(_path: string): boolean {
        // Text handler accepts all files that pass the factory's binary check
        // The factory routes binary files to BinaryFileHandler before reaching here
        return true;
    }

    async read(filePath: string, options?: ReadOptions): Promise<FileResult> {
        const offset = options?.offset ?? 0;
        const length = options?.length ?? 1000; // Default from config
        const includeStatusMessage = options?.includeStatusMessage ?? true;

        // Binary detection is done at factory level - just read as text
        return this.readFileWithSmartPositioning(filePath, offset, length, 'text/plain', includeStatusMessage);
    }

    async write(path: string, content: string, mode: 'rewrite' | 'append' = 'rewrite'): Promise<void> {
        if (mode === 'append') {
            await fs.appendFile(path, content);
        } else {
            await fs.writeFile(path, content);
        }
    }

    async getInfo(path: string): Promise<FileInfo> {
        const stats = await fs.stat(path);

        const info: FileInfo = {
            size: stats.size,
            created: stats.birthtime,
            modified: stats.mtime,
            accessed: stats.atime,
            isDirectory: stats.isDirectory(),
            isFile: stats.isFile(),
            permissions: stats.mode.toString(8).slice(-3),
            fileType: 'text',
            metadata: {}
        };

        // For text files that aren't too large, count lines
        if (stats.isFile() && stats.size < FILE_SIZE_LIMITS.LINE_COUNT_LIMIT) {
            try {
                const content = await fs.readFile(path, 'utf8');
                const lineCount = TextFileHandler.countLines(content);
                info.metadata!.lineCount = lineCount;
            } catch (error) {
                // If reading fails, skip line count
            }
        }

        return info;
    }

    // ========================================================================
    // Private Helper Methods (extracted from filesystem.ts)
    // ========================================================================

    /**
     * Count lines in text content
     * Made static and public for use by other modules (e.g., writeFile telemetry in filesystem.ts)
     */
    static countLines(content: string): number {
        return content.split('\n').length;
    }

    /**
     * Get file line count (for files under size limit)
     */
    private async getFileLineCount(filePath: string): Promise<number | undefined> {
        try {
            const stats = await fs.stat(filePath);
            if (stats.size < FILE_SIZE_LIMITS.LINE_COUNT_LIMIT) {
                const content = await fs.readFile(filePath, 'utf8');
                return TextFileHandler.countLines(content);
            }
        } catch (error) {
            // If we can't read the file, return undefined
        }
        return undefined;
    }

    /**
     * Generate enhanced status message
     */
    private generateEnhancedStatusMessage(
        readLines: number,
        offset: number,
        totalLines?: number,
        isNegativeOffset: boolean = false
    ): string {
        if (isNegativeOffset) {
            if (totalLines !== undefined) {
                return `[Reading last ${readLines} lines (total: ${totalLines} lines)]`;
            } else {
                return `[Reading last ${readLines} lines]`;
            }
        } else {
            if (totalLines !== undefined) {
                const endLine = offset + readLines;
                const remainingLines = Math.max(0, totalLines - endLine);

                if (offset === 0) {
                    return `[Reading ${readLines} lines from start (total: ${totalLines} lines, ${remainingLines} remaining)]`;
                } else {
                    return `[Reading ${readLines} lines from line ${offset} (total: ${totalLines} lines, ${remainingLines} remaining)]`;
                }
            } else {
                if (offset === 0) {
                    return `[Reading ${readLines} lines from start]`;
                } else {
                    return `[Reading ${readLines} lines from line ${offset}]`;
                }
            }
        }
    }

    /**
     * Split text into lines while preserving line endings
     * Made static and public for use by other modules (e.g., readFileInternal in filesystem.ts)
     */
    static splitLinesPreservingEndings(content: string): string[] {
        if (!content) return [''];

        const lines: string[] = [];
        let currentLine = '';

        for (let i = 0; i < content.length; i++) {
            const char = content[i];
            currentLine += char;

            if (char === '\n') {
                lines.push(currentLine);
                currentLine = '';
            } else if (char === '\r') {
                if (i + 1 < content.length && content[i + 1] === '\n') {
                    currentLine += content[i + 1];
                    i++;
                }
                lines.push(currentLine);
                currentLine = '';
            }
        }

        if (currentLine) {
            lines.push(currentLine);
        }

        return lines;
    }

    /**
     * Read file with smart positioning for optimal performance
     */
    private async readFileWithSmartPositioning(
        filePath: string,
        offset: number,
        length: number,
        mimeType: string,
        includeStatusMessage: boolean = true
    ): Promise<FileResult> {
        const stats = await fs.stat(filePath);
        const fileSize = stats.size;

        const totalLines = await this.getFileLineCount(filePath);

        // For negative offsets (tail behavior), use reverse reading
        if (offset < 0) {
            const requestedLines = Math.abs(offset);

            if (fileSize > FILE_SIZE_LIMITS.LARGE_FILE_THRESHOLD &&
                requestedLines <= READ_PERFORMANCE_THRESHOLDS.SMALL_READ_THRESHOLD) {
                return await this.readLastNLinesReverse(filePath, requestedLines, mimeType, includeStatusMessage, totalLines);
            } else {
                return await this.readFromEndWithReadline(filePath, requestedLines, mimeType, includeStatusMessage, totalLines);
            }
        }
        // For positive offsets
        else {
            if (fileSize < FILE_SIZE_LIMITS.LARGE_FILE_THRESHOLD || offset === 0) {
                return await this.readFromStartWithReadline(filePath, offset, length, mimeType, includeStatusMessage, totalLines);
            } else {
                if (offset > READ_PERFORMANCE_THRESHOLDS.DEEP_OFFSET_THRESHOLD) {
                    return await this.readFromEstimatedPosition(filePath, offset, length, mimeType, includeStatusMessage, totalLines);
                } else {
                    return await this.readFromStartWithReadline(filePath, offset, length, mimeType, includeStatusMessage, totalLines);
                }
            }
        }
    }

    /**
     * Read last N lines efficiently by reading file backwards
     */
    private async readLastNLinesReverse(
        filePath: string,
        n: number,
        mimeType: string,
        includeStatusMessage: boolean = true,
        fileTotalLines?: number
    ): Promise<FileResult> {
        const fd = await fs.open(filePath, 'r');
        try {
            const stats = await fd.stat();
            const fileSize = stats.size;

            let position = fileSize;
            let lines: string[] = [];
            let partialLine = '';

            while (position > 0 && lines.length < n) {
                const readSize = Math.min(READ_PERFORMANCE_THRESHOLDS.CHUNK_SIZE, position);
                position -= readSize;

                const buffer = Buffer.alloc(readSize);
                await fd.read(buffer, 0, readSize, position);

                const chunk = buffer.toString('utf-8');
                const text = chunk + partialLine;
                const chunkLines = text.split('\n');

                partialLine = chunkLines.shift() || '';
                lines = chunkLines.concat(lines);
            }

            if (position === 0 && partialLine) {
                lines.unshift(partialLine);
            }

            const result = lines.slice(-n);
            const content = includeStatusMessage
                ? `${this.generateEnhancedStatusMessage(result.length, -n, fileTotalLines, true)}\n\n${result.join('\n')}`
                : result.join('\n');

            return { content, mimeType, metadata: {} };
        } finally {
            await fd.close();
        }
    }

    /**
     * Read from end using readline with circular buffer
     */
    private async readFromEndWithReadline(
        filePath: string,
        requestedLines: number,
        mimeType: string,
        includeStatusMessage: boolean = true,
        fileTotalLines?: number
    ): Promise<FileResult> {
        const rl = createInterface({
            input: createReadStream(filePath),
            crlfDelay: Infinity
        });

        const buffer: string[] = new Array(requestedLines);
        let bufferIndex = 0;
        let totalLines = 0;

        for await (const line of rl) {
            buffer[bufferIndex] = line;
            bufferIndex = (bufferIndex + 1) % requestedLines;
            totalLines++;
        }

        rl.close();

        let result: string[];
        if (totalLines >= requestedLines) {
            result = [
                ...buffer.slice(bufferIndex),
                ...buffer.slice(0, bufferIndex)
            ].filter(line => line !== undefined);
        } else {
            result = buffer.slice(0, totalLines);
        }

        const content = includeStatusMessage
            ? `${this.generateEnhancedStatusMessage(result.length, -requestedLines, fileTotalLines, true)}\n\n${result.join('\n')}`
            : result.join('\n');

        return { content, mimeType, metadata: {} };
    }

    /**
     * Read from start/middle using readline
     */
    private async readFromStartWithReadline(
        filePath: string,
        offset: number,
        length: number,
        mimeType: string,
        includeStatusMessage: boolean = true,
        fileTotalLines?: number
    ): Promise<FileResult> {
        const rl = createInterface({
            input: createReadStream(filePath),
            crlfDelay: Infinity
        });

        const result: string[] = [];
        let lineNumber = 0;

        for await (const line of rl) {
            if (lineNumber >= offset && result.length < length) {
                result.push(line);
            }
            if (result.length >= length) break;
            lineNumber++;
        }

        rl.close();

        if (includeStatusMessage) {
            const statusMessage = this.generateEnhancedStatusMessage(result.length, offset, fileTotalLines, false);
            const content = `${statusMessage}\n\n${result.join('\n')}`;
            return { content, mimeType, metadata: {} };
        } else {
            const content = result.join('\n');
            return { content, mimeType, metadata: {} };
        }
    }

    /**
     * Read from estimated byte position for very large files
     */
    private async readFromEstimatedPosition(
        filePath: string,
        offset: number,
        length: number,
        mimeType: string,
        includeStatusMessage: boolean = true,
        fileTotalLines?: number
    ): Promise<FileResult> {
        // First, do a quick scan to estimate lines per byte
        const rl = createInterface({
            input: createReadStream(filePath),
            crlfDelay: Infinity
        });

        let sampleLines = 0;
        let bytesRead = 0;

        for await (const line of rl) {
            bytesRead += Buffer.byteLength(line, 'utf-8') + 1;
            sampleLines++;
            if (bytesRead >= READ_PERFORMANCE_THRESHOLDS.SAMPLE_SIZE) break;
        }

        rl.close();

        if (sampleLines === 0) {
            return await this.readFromStartWithReadline(filePath, offset, length, mimeType, includeStatusMessage, fileTotalLines);
        }

        // Estimate position
        const avgLineLength = bytesRead / sampleLines;
        const estimatedBytePosition = Math.floor(offset * avgLineLength);

        const fd = await fs.open(filePath, 'r');
        try {
            const stats = await fd.stat();
            const startPosition = Math.min(estimatedBytePosition, stats.size);

            const stream = createReadStream(filePath, { start: startPosition });
            const rl2 = createInterface({
                input: stream,
                crlfDelay: Infinity
            });

            const result: string[] = [];
            let firstLineSkipped = false;

            for await (const line of rl2) {
                if (!firstLineSkipped && startPosition > 0) {
                    firstLineSkipped = true;
                    continue;
                }

                if (result.length < length) {
                    result.push(line);
                } else {
                    break;
                }
            }

            rl2.close();

            const content = includeStatusMessage
                ? `${this.generateEnhancedStatusMessage(result.length, offset, fileTotalLines, false)}\n\n${result.join('\n')}`
                : result.join('\n');

            return { content, mimeType, metadata: {} };
        } finally {
            await fd.close();
        }
    }
}
