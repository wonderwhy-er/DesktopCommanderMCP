import fs from "fs/promises";
import path from "path";
import os from 'os';
import fetch from 'cross-fetch';
import { capture } from '../utils/capture.js';
import { withTimeout } from '../utils/withTimeout.js';
import { configManager } from '../config-manager.js';
import { getFileHandler, TextFileHandler } from '../utils/files/index.js';
import type { ReadOptions, FileResult, PdfPageItem } from '../utils/files/base.js';
import { isPdfFile } from "./mime-types.js";
import { parsePdfToMarkdown, editPdf, PdfOperations, PdfMetadata, parseMarkdownToPdf } from './pdf/index.js';
import { isBinaryFile } from 'isbinaryfile';

// CONSTANTS SECTION - Consolidate all timeouts and thresholds
const FILE_OPERATION_TIMEOUTS = {
    PATH_VALIDATION: 10000,    // 10 seconds
    URL_FETCH: 30000,          // 30 seconds
    FILE_READ: 30000,          // 30 seconds
} as const;

const FILE_SIZE_LIMITS = {
    LINE_COUNT_LIMIT: 10 * 1024 * 1024,      // 10MB for line counting
} as const;

// UTILITY FUNCTIONS - Eliminate duplication

/**
 * Get MIME type information for a file
 * @param filePath Path to the file
 * @returns Object with mimeType and isImage properties
 */
async function getMimeTypeInfo(filePath: string): Promise<{ mimeType: string; isImage: boolean; isPdf: boolean }> {
    const { getMimeType, isImageFile, isPdfFile } = await import('./mime-types.js');
    const mimeType = getMimeType(filePath);
    const isImage = isImageFile(mimeType);
    const isPdf = isPdfFile(mimeType);
    return { mimeType, isImage, isPdf };
}

/**
 * Get file extension for telemetry purposes
 * @param filePath Path to the file
 * @returns Lowercase file extension
 */
function getFileExtension(filePath: string): string {
    return path.extname(filePath).toLowerCase();
}

/**
 * Get default read length from configuration
 * @returns Default number of lines to read
 */
async function getDefaultReadLength(): Promise<number> {
    const config = await configManager.getConfig();
    return config.fileReadLineLimit ?? 1000; // Default to 1000 lines if not set
}

// Initialize allowed directories from configuration
async function getAllowedDirs(): Promise<string[]> {
    try {
        let allowedDirectories;
        const config = await configManager.getConfig();
        if (config.allowedDirectories && Array.isArray(config.allowedDirectories)) {
            allowedDirectories = config.allowedDirectories;
        } else {
            // Fall back to default directories if not configured
            allowedDirectories = [
                os.homedir()   // User's home directory
            ];
            // Update config with default
            await configManager.setValue('allowedDirectories', allowedDirectories);
        }
        return allowedDirectories;
    } catch (error) {
        console.error('Failed to initialize allowed directories:', error);
        // Keep the default permissive path
    }
    return [];
}

// Normalize all paths consistently
function normalizePath(p: string): string {
    return path.normalize(expandHome(p)).toLowerCase();
}

function expandHome(filepath: string): string {
    if (filepath.startsWith('~/') || filepath === '~') {
        return path.join(os.homedir(), filepath.slice(1));
    }
    return filepath;
}

/**
 * Recursively validates parent directories until it finds a valid one
 * This function handles the case where we need to create nested directories
 * and we need to check if any of the parent directories exist
 *
 * @param directoryPath The path to validate
 * @returns Promise<boolean> True if a valid parent directory was found
 */
async function validateParentDirectories(directoryPath: string): Promise<boolean> {
    const parentDir = path.dirname(directoryPath);

    // Base case: we've reached the root or the same directory (shouldn't happen normally)
    if (parentDir === directoryPath || parentDir === path.dirname(parentDir)) {
        return false;
    }

    try {
        // Check if the parent directory exists
        await fs.realpath(parentDir);
        return true;
    } catch {
        // Parent doesn't exist, recursively check its parent
        return validateParentDirectories(parentDir);
    }
}

/**
 * Checks if a path is within any of the allowed directories
 *
 * @param pathToCheck Path to check
 * @returns boolean True if path is allowed
 */
async function isPathAllowed(pathToCheck: string): Promise<boolean> {
    // If root directory is allowed, all paths are allowed
    const allowedDirectories = await getAllowedDirs();
    if (allowedDirectories.includes('/') || allowedDirectories.length === 0) {
        return true;
    }

    let normalizedPathToCheck = normalizePath(pathToCheck);
    if (normalizedPathToCheck.slice(-1) === path.sep) {
        normalizedPathToCheck = normalizedPathToCheck.slice(0, -1);
    }

    // Check if the path is within any allowed directory
    const isAllowed = allowedDirectories.some(allowedDir => {
        let normalizedAllowedDir = normalizePath(allowedDir);
        if (normalizedAllowedDir.slice(-1) === path.sep) {
            normalizedAllowedDir = normalizedAllowedDir.slice(0, -1);
        }

        // Check if path is exactly the allowed directory
        if (normalizedPathToCheck === normalizedAllowedDir) {
            return true;
        }

        // Check if path is a subdirectory of the allowed directory
        // Make sure to add a separator to prevent partial directory name matches
        // e.g. /home/user vs /home/username
        const subdirCheck = normalizedPathToCheck.startsWith(normalizedAllowedDir + path.sep);
        if (subdirCheck) {
            return true;
        }

        // If allowed directory is the root (C:\ on Windows), allow access to the entire drive
        if (normalizedAllowedDir === 'c:' && process.platform === 'win32') {
            return normalizedPathToCheck.startsWith('c:');
        }

        return false;
    });

    return isAllowed;
}

/**
 * Validates a path to ensure it can be accessed or created.
 * For existing paths, returns the real path (resolving symlinks).
 * For non-existent paths, validates parent directories to ensure they exist.
 *
 * @param requestedPath The path to validate
 * @returns Promise<string> The validated path
 * @throws Error if the path or its parent directories don't exist or if the path is not allowed
 */
export async function validatePath(requestedPath: string): Promise<string> {
    const validationOperation = async (): Promise<string> => {
        // Expand home directory if present
        const expandedPath = expandHome(requestedPath);

        // Convert to absolute path
        const absolute = path.isAbsolute(expandedPath)
            ? path.resolve(expandedPath)
            : path.resolve(process.cwd(), expandedPath);

        // Check if path is allowed
        if (!(await isPathAllowed(absolute))) {
            capture('server_path_validation_error', {
                error: 'Path not allowed',
                allowedDirsCount: (await getAllowedDirs()).length
            });

            throw new Error(`Path not allowed: ${requestedPath}. Must be within one of these directories: ${(await getAllowedDirs()).join(', ')}`);
        }

        // Check if path exists
        try {
            const stats = await fs.stat(absolute);
            // If path exists, resolve any symlinks
            return await fs.realpath(absolute);
        } catch (error) {
            // Path doesn't exist - validate parent directories
            if (await validateParentDirectories(absolute)) {
                // Return the path if a valid parent exists
                // This will be used for folder creation and many other file operations
                return absolute;
            }
            // If no valid parent found, return the absolute path anyway
            return absolute;
        }
    };

    // Execute with timeout
    const result = await withTimeout(
        validationOperation(),
        FILE_OPERATION_TIMEOUTS.PATH_VALIDATION,
        `Path validation operation`, // Generic name for telemetry
        null
    );

    if (result === null) {
        // Keep original path in error for AI but a generic message for telemetry
        capture('server_path_validation_timeout', {
            timeoutMs: FILE_OPERATION_TIMEOUTS.PATH_VALIDATION
        });

        throw new Error(`Path validation failed for path: ${requestedPath}`);
    }

    return result;
}

// Re-export FileResult from base for consumers
export type { FileResult } from '../utils/files/base.js';

type PdfPayload = {
    metadata: PdfMetadata;
    pages: PdfPageItem[];
}

type FileResultPayloads = PdfPayload;

/**
 * Read file content from a URL
 * @param url URL to fetch content from
 * @returns File content or file result with metadata
 */
export async function readFileFromUrl(url: string): Promise<FileResult> {
    // Import the MIME type utilities
    const { isImageFile } = await import('./mime-types.js');

    // Set up fetch with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FILE_OPERATION_TIMEOUTS.URL_FETCH);

    try {
        const response = await fetch(url, {
            signal: controller.signal
        });

        // Clear the timeout since fetch completed
        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }

        // Get MIME type from Content-Type header or infer from URL
        const contentType = response.headers.get('content-type') || 'text/plain';
        const isImage = isImageFile(contentType);
        const isPdf = isPdfFile(contentType) || url.toLowerCase().endsWith('.pdf');

        // NEW: Add PDF handling before image check
        if (isPdf) {
            // Use URL directly - pdfreader handles URL downloads internally
            const pdfResult = await parsePdfToMarkdown(url);

            return {
                content: "",
                mimeType: 'text/plain',
                metadata: {
                    isImage: false,
                    isPdf: true,
                    author: pdfResult.metadata.author,
                    title: pdfResult.metadata.title,
                    totalPages: pdfResult.metadata.totalPages,
                    pages: pdfResult.pages
                }
            };

        } else if (isImage) {
            // For images, convert to base64
            const buffer = await response.arrayBuffer();
            const content = Buffer.from(buffer).toString('base64');

            return { content, mimeType: contentType, metadata: { isImage } };
        } else {
            // For text content
            const content = await response.text();

            return { content, mimeType: contentType, metadata: { isImage } };
        }
    } catch (error) {
        // Clear the timeout to prevent memory leaks
        clearTimeout(timeoutId);

        // Return error information instead of throwing
        const errorMessage = error instanceof DOMException && error.name === 'AbortError'
            ? `URL fetch timed out after ${FILE_OPERATION_TIMEOUTS.URL_FETCH}ms: ${url}`
            : `Failed to fetch URL: ${error instanceof Error ? error.message : String(error)}`;

        throw new Error(errorMessage);
    }
}

/**
 * Read file content from the local filesystem
 * @param filePath Path to the file
 * @param options Read options (offset, length, sheet, range)
 * @returns File content or file result with metadata
 */
export async function readFileFromDisk(
    filePath: string,
    options?: ReadOptions
): Promise<FileResult> {
    const { offset = 0, sheet, range } = options ?? {};
    let { length } = options ?? {};

    // Add validation for required parameters
    if (!filePath || typeof filePath !== 'string') {
        throw new Error('Invalid file path provided');
    }

    // Get default length from config if not provided
    if (length === undefined) {
        length = await getDefaultReadLength();
    }

    const validPath = await validatePath(filePath);

    // Get file extension for telemetry
    const fileExtension = getFileExtension(validPath);

    // Check file size before attempting to read
    try {
        const stats = await fs.stat(validPath);

        // Capture file extension in telemetry without capturing the file path
        capture('server_read_file', {
            fileExtension: fileExtension,
            offset: offset,
            length: length,
            fileSize: stats.size
        });
    } catch (error) {
        console.error('error catch ' + error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        capture('server_read_file_error', { error: errorMessage, fileExtension: fileExtension });
        // If we can't stat the file, continue anyway and let the read operation handle errors
    }

    // Use withTimeout to handle potential hangs
    const readOperation = async () => {
        // Get appropriate handler for this file type (async - includes binary detection)
        const handler = await getFileHandler(validPath);

        // Use handler to read the file
        const result = await handler.read(validPath, {
            offset,
            length,
            sheet,
            range,
            includeStatusMessage: true
        });

        // Return with content as string
        // For images: content is already base64-encoded string from handler
        // For text: content may be string or Buffer, convert to UTF-8 string
        let content: string;
        if (typeof result.content === 'string') {
            content = result.content;
        } else if (result.metadata?.isImage) {
            // Image buffer should be base64 encoded, not UTF-8 converted
            content = result.content.toString('base64');
        } else {
            content = result.content.toString('utf8');
        }

        return {
            content,
            mimeType: result.mimeType,
            metadata: result.metadata
        };
    };

    // Execute with timeout
    const result = await withTimeout(
        readOperation(),
        FILE_OPERATION_TIMEOUTS.FILE_READ,
        `Read file operation for ${filePath}`,
        null
    );

    if (result == null) {
        // Handles the impossible case where withTimeout resolves to null instead of throwing
        throw new Error('Failed to read the file');
    }

    return result;
}

/**
 * Read a file from either the local filesystem or a URL
 * @param filePath Path to the file or URL
 * @param options Read options (isUrl, offset, length, sheet, range)
 * @returns File content or file result with metadata
 */
export async function readFile(
    filePath: string,
    options?: ReadOptions
): Promise<FileResult> {
    const { isUrl, offset, length, sheet, range } = options ?? {};
    return isUrl
        ? readFileFromUrl(filePath)
        : readFileFromDisk(filePath, { offset, length, sheet, range });
}

/**
 * Read file content without status messages for internal operations
 * This function preserves exact file content including original line endings,
 * which is essential for edit operations that need to maintain file formatting.
 * @param filePath Path to the file
 * @param offset Starting line number to read from (default: 0)
 * @param length Maximum number of lines to read (default: from config or 1000)
 * @returns File content without status headers, with preserved line endings
 */
export async function readFileInternal(filePath: string, offset: number = 0, length?: number): Promise<string> {
    // Get default length from config if not provided
    if (length === undefined) {
        length = await getDefaultReadLength();
    }

    const validPath = await validatePath(filePath);

    // Get file extension and MIME type
    const fileExtension = getFileExtension(validPath);
    const { mimeType, isImage } = await getMimeTypeInfo(validPath);

    if (isImage) {
        throw new Error('Cannot read image files as text for internal operations');
    }

    // IMPORTANT: For internal operations (especially edit operations), we must
    // preserve exact file content including original line endings.
    // We cannot use readline-based reading as it strips line endings.

    // Read entire file content preserving line endings
    const content = await fs.readFile(validPath, 'utf8');

    // If we need to apply offset/length, do it while preserving line endings
    if (offset === 0 && length >= Number.MAX_SAFE_INTEGER) {
        // Most common case for edit operations: read entire file
        return content;
    }

    // Handle offset/length by splitting on line boundaries while preserving line endings
    const lines = TextFileHandler.splitLinesPreservingEndings(content);

    // Apply offset and length
    const selectedLines = lines.slice(offset, offset + length);

    // Join back together (this preserves the original line endings)
    return selectedLines.join('');
}

export async function writeFile(filePath: string, content: string, mode: 'rewrite' | 'append' = 'rewrite'): Promise<void> {
    const validPath = await validatePath(filePath);

    // Get file extension for telemetry
    const fileExtension = getFileExtension(validPath);

    // Calculate content metrics
    const contentBytes = Buffer.from(content).length;
    const lineCount = TextFileHandler.countLines(content);

    // Capture file extension and operation details in telemetry without capturing the file path
    capture('server_write_file', {
        fileExtension: fileExtension,
        mode: mode,
        contentBytes: contentBytes,
        lineCount: lineCount
    });

    // Get appropriate handler for this file type (async - includes binary detection)
    const handler = await getFileHandler(validPath);

    // Use handler to write the file
    await handler.write(validPath, content, mode);
}

export interface MultiFileResult {
    path: string;
    content?: string;
    mimeType?: string;
    isImage?: boolean;
    error?: string;
    isPdf?: boolean;
    payload?: FileResultPayloads;
}

export async function readMultipleFiles(paths: string[]): Promise<MultiFileResult[]> {
    return Promise.all(
        paths.map(async (filePath: string) => {
            try {
                const validPath = await validatePath(filePath);
                const fileResult = await readFile(validPath);
                // Handle content conversion properly for images vs text
                let content: string;
                if (typeof fileResult.content === 'string') {
                    content = fileResult.content;
                } else if (fileResult.metadata?.isImage) {
                    content = fileResult.content.toString('base64');
                } else {
                    content = fileResult.content.toString('utf8');
                }

                return {
                    path: filePath,
                    content,
                    mimeType: fileResult.mimeType,
                    isImage: fileResult.metadata?.isImage ?? false,
                    isPdf: fileResult.metadata?.isPdf ?? false,
                    payload: fileResult.metadata?.isPdf ? {
                        metadata: {
                            author: fileResult.metadata.author,
                            title: fileResult.metadata.title,
                            totalPages: fileResult.metadata.totalPages ?? 0
                        },
                        pages: fileResult.metadata.pages ?? []
                    } : undefined
                };
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                return {
                    path: filePath,
                    error: errorMessage
                };
            }
        }),
    );
}

export async function createDirectory(dirPath: string): Promise<void> {
    const validPath = await validatePath(dirPath);
    await fs.mkdir(validPath, { recursive: true });
}

export async function listDirectory(dirPath: string, depth: number = 2): Promise<string[]> {
    const validPath = await validatePath(dirPath);
    const results: string[] = [];

    const MAX_NESTED_ITEMS = 100; // Maximum items to show per nested directory

    async function listRecursive(currentPath: string, currentDepth: number, relativePath: string = '', isTopLevel: boolean = true): Promise<void> {
        if (currentDepth <= 0) return;

        let entries;
        try {
            entries = await fs.readdir(currentPath, { withFileTypes: true });
        } catch (error) {
            // If we can't read this directory (permission denied), show as denied
            const displayPath = relativePath || path.basename(currentPath);
            results.push(`[DENIED] ${displayPath}`);
            return;
        }

        // Apply filtering for nested directories (not top level)
        const totalEntries = entries.length;
        let entriesToShow = entries;
        let filteredCount = 0;

        if (!isTopLevel && totalEntries > MAX_NESTED_ITEMS) {
            entriesToShow = entries.slice(0, MAX_NESTED_ITEMS);
            filteredCount = totalEntries - MAX_NESTED_ITEMS;
        }

        for (const entry of entriesToShow) {
            const fullPath = path.join(currentPath, entry.name);
            const displayPath = relativePath ? path.join(relativePath, entry.name) : entry.name;

            // Add this entry to results
            results.push(`${entry.isDirectory() ? "[DIR]" : "[FILE]"} ${displayPath}`);

            // If it's a directory and we have depth remaining, recurse
            if (entry.isDirectory() && currentDepth > 1) {
                try {
                    // Validate the path before recursing
                    await validatePath(fullPath);
                    await listRecursive(fullPath, currentDepth - 1, displayPath, false);
                } catch (error) {
                    // If validation fails or we can't access it, it will be marked as denied
                    // when we try to read it in the recursive call
                    continue;
                }
            }
        }

        // Add warning message if items were filtered
        if (filteredCount > 0) {
            const displayPath = relativePath || path.basename(currentPath);
            results.push(`[WARNING] ${displayPath}: ${filteredCount} items hidden (showing first ${MAX_NESTED_ITEMS} of ${totalEntries} total)`);
        }
    }

    await listRecursive(validPath, depth, '', true);
    return results;
}

export async function moveFile(sourcePath: string, destinationPath: string): Promise<void> {
    const validSourcePath = await validatePath(sourcePath);
    const validDestPath = await validatePath(destinationPath);
    await fs.rename(validSourcePath, validDestPath);
}

export async function searchFiles(rootPath: string, pattern: string): Promise<string[]> {
    // Use the new search manager for better performance
    // This provides a temporary compatibility layer until we fully migrate to search sessions
    const { searchManager } = await import('../search-manager.js');

    try {
        const result = await searchManager.startSearch({
            rootPath,
            pattern,
            searchType: 'files',
            ignoreCase: true,
            maxResults: 5000, // Higher limit for compatibility
            earlyTermination: true, // Use early termination for better performance
        });

        const sessionId = result.sessionId;

        // Poll for results until complete
        let allResults: string[] = [];
        let isComplete = result.isComplete;
        let startTime = Date.now();

        // Add initial results
        for (const searchResult of result.results) {
            if (searchResult.type === 'file') {
                allResults.push(searchResult.file);
            }
        }

        while (!isComplete) {
            await new Promise(resolve => setTimeout(resolve, 100)); // Wait 100ms

            const results = searchManager.readSearchResults(sessionId);
            isComplete = results.isComplete;

            // Add new file paths to results
            for (const searchResult of results.results) {
                if (searchResult.file !== '__LAST_READ_MARKER__' && searchResult.type === 'file') {
                    allResults.push(searchResult.file);
                }
            }

            // Safety check to prevent infinite loops (30 second timeout)
            if (Date.now() - startTime > 30000) {
                searchManager.terminateSearch(sessionId);
                break;
            }
        }

        // Log only the count of found files, not their paths
        capture('server_search_files_complete', {
            resultsCount: allResults.length,
            patternLength: pattern.length,
            usedRipgrep: true
        });

        return allResults;
    } catch (error) {
        // Fallback to original Node.js implementation if ripgrep fails
        capture('server_search_files_ripgrep_fallback', {
            error: error instanceof Error ? error.message : 'Unknown error'
        });

        return await searchFilesNodeJS(rootPath, pattern);
    }
}

// Keep the original Node.js implementation as fallback
async function searchFilesNodeJS(rootPath: string, pattern: string): Promise<string[]> {
    const results: string[] = [];

    async function search(currentPath: string): Promise<void> {
        let entries;
        try {
            entries = await fs.readdir(currentPath, { withFileTypes: true });
        } catch (error) {
            return; // Skip this directory on error
        }

        for (const entry of entries) {
            const fullPath = path.join(currentPath, entry.name);

            try {
                await validatePath(fullPath);

                if (entry.name.toLowerCase().includes(pattern.toLowerCase())) {
                    results.push(fullPath);
                }

                if (entry.isDirectory()) {
                    await search(fullPath);
                }
            } catch (error) {
                continue;
            }
        }
    }

    try {
        // Validate root path before starting search
        const validPath = await validatePath(rootPath);
        await search(validPath);

        // Log only the count of found files, not their paths
        capture('server_search_files_complete', {
            resultsCount: results.length,
            patternLength: pattern.length,
            usedRipgrep: false
        });

        return results;
    } catch (error) {
        // For telemetry only - sanitize error info
        capture('server_search_files_error', {
            errorType: error instanceof Error ? error.name : 'Unknown',
            error: 'Error with root path',
            isRootPathError: true
        });

        // Re-throw the original error for the caller
        throw error;
    }
}

export async function getFileInfo(filePath: string): Promise<Record<string, any>> {
    const validPath = await validatePath(filePath);

    // Get fs.stat as a fallback for any missing fields
    const stats = await fs.stat(validPath);
    const fallbackInfo = {
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime,
        accessed: stats.atime,
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
        permissions: stats.mode.toString(8).slice(-3),
        fileType: 'text' as const,
        metadata: undefined as Record<string, any> | undefined,
    };

    // Get appropriate handler for this file type (async - includes binary detection)
    const handler = await getFileHandler(validPath);

    // Use handler to get file info, with fallback
    let fileInfo;
    try {
        fileInfo = await handler.getInfo(validPath);
    } catch (error) {
        // If handler fails, use fallback stats
        fileInfo = fallbackInfo;
    }

    // Convert to legacy format (for backward compatibility)
    // Use handler values with fallback to fs.stat values for any missing fields
    const info: Record<string, any> = {
        size: fileInfo.size ?? fallbackInfo.size,
        created: fileInfo.created ?? fallbackInfo.created,
        modified: fileInfo.modified ?? fallbackInfo.modified,
        accessed: fileInfo.accessed ?? fallbackInfo.accessed,
        isDirectory: fileInfo.isDirectory ?? fallbackInfo.isDirectory,
        isFile: fileInfo.isFile ?? fallbackInfo.isFile,
        permissions: fileInfo.permissions ?? fallbackInfo.permissions,
        fileType: fileInfo.fileType ?? fallbackInfo.fileType,
    };

    // Add type-specific metadata from file handler
    if (fileInfo.metadata) {
        // For text files
        if (fileInfo.metadata.lineCount !== undefined) {
            info.lineCount = fileInfo.metadata.lineCount;
            info.lastLine = fileInfo.metadata.lineCount - 1;
            info.appendPosition = fileInfo.metadata.lineCount;
        }

        // For Excel files
        if (fileInfo.metadata.sheets) {
            info.sheets = fileInfo.metadata.sheets;
            info.isExcelFile = true;
        }

        // For images
        if (fileInfo.metadata.isImage) {
            info.isImage = true;
        }

        // For PDF files
        if (fileInfo.metadata.isPdf) {
            info.isPdf = true;
            info.totalPages = fileInfo.metadata.totalPages;
            if (fileInfo.metadata.title) info.title = fileInfo.metadata.title;
            if (fileInfo.metadata.author) info.author = fileInfo.metadata.author;
        }

        // For binary files
        if (fileInfo.metadata.isBinary) {
            info.isBinary = true;
        }
    }

    return info;
}


/**
 * Write content to a PDF file.
 * Can create a new PDF from Markdown string, or modify an existing PDF using operations.
 * 
 * @param filePath Path to the output PDF file
 * @param content Markdown string (for creation) or array of operations (for modification)
 * @param options Options for PDF generation or modification. For modification, can include `sourcePdf`.
 */
export async function writePdf(
    filePath: string,
    content: string | PdfOperations[],
    outputPath?: string,
    options: any = {}
): Promise<void> {
    const validPath = await validatePath(filePath);
    const fileExtension = getFileExtension(validPath);

    if (typeof content === 'string') {
        // --- PDF CREATION MODE ---
        capture('server_write_pdf', {
            fileExtension: fileExtension,
            contentLength: content.length,
            mode: 'create'
        });

        const pdfBuffer = await parseMarkdownToPdf(content, options);
        // Use outputPath if provided, otherwise overwrite input file
        const targetPath = outputPath ? await validatePath(outputPath) : validPath;
        await fs.writeFile(targetPath, pdfBuffer);
    } else if (Array.isArray(content)) {

        // Use outputPath if provided, otherwise overwrite input file
        const targetPath = outputPath ? await validatePath(outputPath) : validPath;

        const operations: PdfOperations[] = [];

        // Validate paths in operations
        for (const o of content) {
            if (o.type === 'insert') {
                if (o.sourcePdfPath) {
                    o.sourcePdfPath = await validatePath(o.sourcePdfPath);
                }
            }
            operations.push(o);
        }

        capture('server_write_pdf', {
            fileExtension: fileExtension,
            operationCount: operations.length,
            mode: 'modify',
            deleteCount: operations.filter(op => op.type === 'delete').length,
            insertCount: operations.filter(op => op.type === 'insert').length
        });

        // Perform the PDF editing
        const modifiedPdfBuffer = await editPdf(validPath, operations);

        // Write the modified PDF to the output path
        await fs.writeFile(targetPath, modifiedPdfBuffer);
    } else {
        throw new Error('Invalid content type for writePdf. Expected string (markdown) or array of operations.');
    }
}