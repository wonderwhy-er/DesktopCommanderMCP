import fs from "fs/promises";
import path from "path";
import os from 'os';
import fetch from 'cross-fetch';
import {capture} from '../utils/capture.js';
import {withTimeout} from '../utils/withTimeout.js';
import {configManager} from '../config-manager.js';

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
    if(normalizedPathToCheck.slice(-1) === path.sep) {
        normalizedPathToCheck = normalizedPathToCheck.slice(0, -1);
    }

    // Check if the path is within any allowed directory
    const isAllowed = allowedDirectories.some(allowedDir => {
        let normalizedAllowedDir = normalizePath(allowedDir);
        if(normalizedAllowedDir.slice(-1) === path.sep) {
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
    const PATH_VALIDATION_TIMEOUT = 10000; // 10 seconds timeout
    
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
        PATH_VALIDATION_TIMEOUT,
        `Path validation operation`, // Generic name for telemetry
        null
    );
    
    if (result === null) {
        // Keep original path in error for AI but a generic message for telemetry
        capture('server_path_validation_timeout', {
            timeoutMs: PATH_VALIDATION_TIMEOUT
        });

        throw new Error(`Path validation failed for path: ${requestedPath}`);
    }
    
    return result;
}

// File operation tools
export interface FileResult {
    content: string;
    mimeType: string;
    isImage: boolean;
}


/**
 * Read file content from a URL
 * @param url URL to fetch content from
 * @returns File content or file result with metadata
 */
export async function readFileFromUrl(url: string): Promise<FileResult> {
    // Import the MIME type utilities
    const { isImageFile } = await import('./mime-types.js');
    
    // Set up fetch with timeout
    const FETCH_TIMEOUT_MS = 30000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    
    try {
        const response = await fetch(url, {
            signal: controller.signal
        });
        
        // Clear the timeout since fetch completed
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }
        
        // Get MIME type from Content-Type header
        const contentType = response.headers.get('content-type') || 'text/plain';
        const isImage = isImageFile(contentType);
        
        if (isImage) {
            // For images, convert to base64
            const buffer = await response.arrayBuffer();
            const content = Buffer.from(buffer).toString('base64');
            
            return { content, mimeType: contentType, isImage };
        } else {
            // For text content
            const content = await response.text();
            
            return { content, mimeType: contentType, isImage };
        }
    } catch (error) {
        // Clear the timeout to prevent memory leaks
        clearTimeout(timeoutId);
        
        // Return error information instead of throwing
        const errorMessage = error instanceof DOMException && error.name === 'AbortError'
            ? `URL fetch timed out after ${FETCH_TIMEOUT_MS}ms: ${url}`
            : `Failed to fetch URL: ${error instanceof Error ? error.message : String(error)}`;

        throw new Error(errorMessage);
    }
}

/**
 * Read file content from the local filesystem
 * @param filePath Path to the file
 * @param offset Starting line number to read from (default: 0)
 * @param length Maximum number of lines to read (default: from config or 1000)
 * @returns File content or file result with metadata
 */
export async function readFileFromDisk(filePath: string, offset: number = 0, length?: number): Promise<FileResult> {
    // Add validation for required parameters
    if (!filePath || typeof filePath !== 'string') {
        throw new Error('Invalid file path provided');
    }
    
    // Import the MIME type utilities
    const { getMimeType, isImageFile } = await import('./mime-types.js');
    
    // Get default length from config if not provided
    if (length === undefined) {
        const config = await configManager.getConfig();
        length = config.fileReadLineLimit ?? 1000; // Default to 1000 lines if not set
    }

    const validPath = await validatePath(filePath);
    
    // Get file extension for telemetry using path module consistently
    const fileExtension = path.extname(validPath).toLowerCase();

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
        capture('server_read_file_error', {error: errorMessage, fileExtension: fileExtension});
        // If we can't stat the file, continue anyway and let the read operation handle errors
    }
    
    // Detect the MIME type based on file extension
    const mimeType = getMimeType(validPath);
    const isImage = isImageFile(mimeType);
    
    const FILE_READ_TIMEOUT = 30000; // 30 seconds timeout for file operations
    
    // Use withTimeout to handle potential hangs
    const readOperation = async () => {
        if (isImage) {
            // For image files, read as Buffer and convert to base64
            // Images are always read in full, ignoring offset and length
            const buffer = await fs.readFile(validPath);
            const content = buffer.toString('base64');
            
            return { content, mimeType, isImage };
        } else {
            // For all other files, try to read as UTF-8 text with line-based offset and length
            try {
                // Read the entire file first
                const buffer = await fs.readFile(validPath);
                const fullContent = buffer.toString('utf-8');
                
                // Split into lines for line-based access
                const lines = fullContent.split('\n');
                const totalLines = lines.length;
                
                // Apply line-based offset and length - handle beyond-file-size scenario
                let startLine = Math.min(offset, totalLines);
                let endLine = Math.min(startLine + length, totalLines);
                
                // If startLine equals totalLines (reading beyond end), adjust to show some content
                // Only do this if we're not trying to read the whole file
                if (startLine === totalLines && offset > 0 && length < Number.MAX_SAFE_INTEGER) {
                    // Show last few lines instead of nothing
                    const lastLinesCount = Math.min(10, totalLines); // Show last 10 lines or fewer if file is smaller
                    startLine = Math.max(0, totalLines - lastLinesCount);
                    endLine = totalLines;
                }
                
                const selectedLines = lines.slice(startLine, endLine);
                const truncatedContent = selectedLines.join('\n');
                
                // Add an informational message if truncated or adjusted
                let content = truncatedContent;
                
                // Only add informational message for normal reads (not when reading entire file)
                const isEntireFileRead = offset === 0 && length >= Number.MAX_SAFE_INTEGER;
                
                if (!isEntireFileRead) {
                    if (offset >= totalLines && totalLines > 0) {
                        // Reading beyond end of file case
                        content = `[NOTICE: Offset ${offset} exceeds file length (${totalLines} lines). Showing last ${endLine - startLine} lines instead.]\n\n${truncatedContent}`;
                    } else if (offset > 0 || endLine < totalLines) {
                        // Normal partial read case
                        content = `[Reading ${endLine - startLine} lines from line ${startLine} of ${totalLines} total lines]\n\n${truncatedContent}`;
                    }
                }
                
                return { content, mimeType, isImage };
            } catch (error) {
                // If UTF-8 reading fails, treat as binary and return base64 but still as text
                const buffer = await fs.readFile(validPath);
                const content = `Binary file content (base64 encoded):\n${buffer.toString('base64')}`;

                return { content, mimeType: 'text/plain', isImage: false };
            }
        }
    };
    // Execute with timeout
    const result = await withTimeout(
        readOperation(),
        FILE_READ_TIMEOUT,
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
 * @param isUrl Whether the path is a URL
 * @param offset Starting line number to read from (default: 0)
 * @param length Maximum number of lines to read (default: from config or 1000)
 * @returns File content or file result with metadata
 */
export async function readFile(filePath: string, isUrl?: boolean, offset?: number, length?: number): Promise<FileResult> {
    return isUrl 
        ? readFileFromUrl(filePath)
        : readFileFromDisk(filePath, offset, length);
}

export async function writeFile(filePath: string, content: string, mode: 'rewrite' | 'append' = 'rewrite'): Promise<void> {
    const validPath = await validatePath(filePath);

    // Get file extension for telemetry
    const fileExtension = path.extname(validPath).toLowerCase();

    // Calculate content metrics
    const contentBytes = Buffer.from(content).length;
    const lineCount = content.split('\n').length;

    // Capture file extension and operation details in telemetry without capturing the file path
    capture('server_write_file', {
        fileExtension: fileExtension,
        mode: mode,
        contentBytes: contentBytes,
        lineCount: lineCount
    });

    // Use different fs methods based on mode
    if (mode === 'append') {
        await fs.appendFile(validPath, content);
    } else {
        await fs.writeFile(validPath, content);
    }
}

export interface MultiFileResult {
    path: string;
    content?: string;
    mimeType?: string;
    isImage?: boolean;
    error?: string;
}

export async function readMultipleFiles(paths: string[]): Promise<MultiFileResult[]> {
    return Promise.all(
        paths.map(async (filePath: string) => {
            try {
                const validPath = await validatePath(filePath);
                const fileResult = await readFile(validPath);

                return {
                    path: filePath,
                    content: typeof fileResult === 'string' ? fileResult : fileResult.content,
                    mimeType: typeof fileResult === 'string' ? "text/plain" : fileResult.mimeType,
                    isImage: typeof fileResult === 'string' ? false : fileResult.isImage
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

export async function listDirectory(dirPath: string): Promise<string[]> {
    const validPath = await validatePath(dirPath);
    const entries = await fs.readdir(validPath, { withFileTypes: true });
    return entries.map((entry) => `${entry.isDirectory() ? "[DIR]" : "[FILE]"} ${entry.name}`);
}

export async function moveFile(sourcePath: string, destinationPath: string): Promise<void> {
    const validSourcePath = await validatePath(sourcePath);
    const validDestPath = await validatePath(destinationPath);
    await fs.rename(validSourcePath, validDestPath);
}

export async function searchFiles(rootPath: string, pattern: string): Promise<string[]> {
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
            patternLength: pattern.length
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
    const stats = await fs.stat(validPath);
    
    // Basic file info
    const info: Record<string, any> = {
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime,
        accessed: stats.atime,
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
        permissions: stats.mode.toString(8).slice(-3),
    };
    
    // For text files that aren't too large, also count lines
    if (stats.isFile() && stats.size < 10 * 1024 * 1024) { // Limit to 10MB files
        try {
            // Import the MIME type utilities
            const { getMimeType, isImageFile } = await import('./mime-types.js');
            const mimeType = getMimeType(validPath);
            
            // Only count lines for non-image, likely text files
            if (!isImageFile(mimeType)) {
                const content = await fs.readFile(validPath, 'utf8');
                const lineCount = content.split('\n').length;
                info.lineCount = lineCount;
                info.lastLine = lineCount - 1; // Zero-indexed last line
                info.appendPosition = lineCount; // Position to append at end
            }
        } catch (error) {
            // If reading fails, just skip the line count
            // This could happen for binary files or very large files
        }
    }
    
    return info;
}

// This function has been replaced with configManager.getConfig()
// Use get_config tool to retrieve allowedDirectories