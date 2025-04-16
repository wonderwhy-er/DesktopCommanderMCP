import fs from "fs/promises";
import path from "path";
import os from 'os';
import fetch from 'cross-fetch';
import {capture, withTimeout} from '../utils.js';
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
            throw(`Path not allowed: ${requestedPath}. Must be within one of these directories: ${(await getAllowedDirs()).join(', ')}`);
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
        `Path validation for ${requestedPath}`,
        null
    );
    
    if (result === null) {
        // Return a path with an error indicator instead of throwing
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
 * @param returnMetadata Whether to return metadata with the content
 * @returns File content or file result with metadata
 */
export async function readFileFromDisk(filePath: string): Promise<FileResult> {
    // Import the MIME type utilities
    const { getMimeType, isImageFile } = await import('./mime-types.js');

    const validPath = await validatePath(filePath);
    
    // Check file size before attempting to read
    try {
        const stats = await fs.stat(validPath);
        const MAX_SIZE = 100 * 1024; // 100KB limit
        
        if (stats.size > MAX_SIZE) {
            const message = `File too large (${(stats.size / 1024).toFixed(2)}KB > ${MAX_SIZE / 1024}KB limit)`;
            return { 
                content: message, 
                mimeType: 'text/plain', 
                isImage: false 
            };
        }
    } catch (error) {
        console.error('error catch ' + error)
        capture('server_read_file_error', {error: error});
        // If we can't stat the file, continue anyway and let the read operation handle errors
        //console.error(`Failed to stat file ${validPath}:`, error);
    }
    
    // Detect the MIME type based on file extension
    const mimeType = getMimeType(validPath);
    const isImage = isImageFile(mimeType);
    
    const FILE_READ_TIMEOUT = 30000; // 30 seconds timeout for file operations
    
    // Use withTimeout to handle potential hangs
    const readOperation = async () => {
        if (isImage) {
            // For image files, read as Buffer and convert to base64
            const buffer = await fs.readFile(validPath);
            const content = buffer.toString('base64');
            
            return { content, mimeType, isImage };
        } else {
            // For all other files, try to read as UTF-8 text
            try {
                const content = await fs.readFile(validPath, "utf-8");
                
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
 * @param returnMetadata Whether to return metadata with the content
 * @param isUrl Whether the path is a URL
 * @returns File content or file result with metadata
 */
export async function readFile(filePath: string, isUrl?: boolean): Promise<FileResult> {
    return isUrl 
        ? readFileFromUrl(filePath)
        : readFileFromDisk(filePath);
}

export async function writeFile(filePath: string, content: string): Promise<void> {
    const validPath = await validatePath(filePath);
    await fs.writeFile(validPath, content, "utf-8");
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

    async function search(currentPath: string) {
        const entries = await fs.readdir(currentPath, { withFileTypes: true });

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
    
    // if path not exist, it will throw an error
    const validPath = await validatePath(rootPath);
    await search(validPath);
    return results;
}

export async function getFileInfo(filePath: string): Promise<Record<string, any>> {
    const validPath = await validatePath(filePath);
    const stats = await fs.stat(validPath);
    
    return {
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime,
        accessed: stats.atime,
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
        permissions: stats.mode.toString(8).slice(-3),
    };
}

// This function has been replaced with configManager.getConfig()
// Use get_config tool to retrieve allowedDirectories