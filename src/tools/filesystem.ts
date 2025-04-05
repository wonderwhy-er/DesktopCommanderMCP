import fs from "fs/promises";
import path from "path";
import os from 'os';

// Store allowed directories - temporarily allowing all paths
// TODO: Make this configurable through a configuration file
const allowedDirectories: string[] = [
    "/" // Root directory - effectively allows all paths
];

// Original implementation commented out for future reference
/*
const allowedDirectories: string[] = [
    process.cwd(), // Current working directory
    os.homedir()   // User's home directory
];
*/

// Normalize all paths consistently
function normalizePath(p: string): string {
    return path.normalize(p).toLowerCase();
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
 * Validates a path to ensure it can be accessed or created.
 * For existing paths, returns the real path (resolving symlinks).
 * For non-existent paths, validates parent directories to ensure they exist.
 * 
 * @param requestedPath The path to validate
 * @returns Promise<string> The validated path
 * @throws Error if the path or its parent directories don't exist
 */
export async function validatePath(requestedPath: string): Promise<string> {
    // Expand home directory if present
    const expandedPath = expandHome(requestedPath);
    
    // Convert to absolute path
    const absolute = path.isAbsolute(expandedPath)
        ? path.resolve(expandedPath)
        : path.resolve(process.cwd(), expandedPath);
    
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
        
        // If no valid parent directory was found, still return the absolute path
        // to maintain compatibility with upstream behavior, but log a warning
        console.warn(`Warning: Parent directory does not exist: ${path.dirname(absolute)}`);
        return absolute;
    }
}

// File operation tools
export interface FileResult {
    content: string;
    mimeType: string;
    isImage: boolean;
}


export async function readFile(filePath: string, returnMetadata?: boolean): Promise<string | FileResult> {
    const validPath = await validatePath(filePath);
    
    // Import the MIME type utilities
    const { getMimeType, isImageFile } = await import('./mime-types.js');
    
    // Detect the MIME type based on file extension
    const mimeType = getMimeType(validPath);
    const isImage = isImageFile(mimeType);
    
    if (isImage) {
        // For image files, read as Buffer and convert to base64
        const buffer = await fs.readFile(validPath);
        const content = buffer.toString('base64');
        
        if (returnMetadata === true) {
            return { content, mimeType, isImage };
        } else {
            return content;
        }
    } else {
        // For all other files, try to read as UTF-8 text
        try {
            const content = await fs.readFile(validPath, "utf-8");
            
            if (returnMetadata === true) {
                return { content, mimeType, isImage };
            } else {
                return content;
            }
        } catch (error) {
            // If UTF-8 reading fails, treat as binary and return base64 but still as text
            const buffer = await fs.readFile(validPath);
            const content = `Binary file content (base64 encoded):\n${buffer.toString('base64')}`;
            
            if (returnMetadata === true) {
                return { content, mimeType: 'text/plain', isImage: false };
            } else {
                return content;
            }
        }
    }
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
                const fileResult = await readFile(validPath, true);

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

export function listAllowedDirectories(): string[] {
    return ["/ (All paths are currently allowed)"];
}
