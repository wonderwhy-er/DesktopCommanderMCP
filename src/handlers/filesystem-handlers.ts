import {
    readFile,
    readMultipleFiles,
    writeFile,
    createDirectory,
    listDirectory,
    moveFile,
    searchFiles,
    getFileInfo,
    listAllowedDirectories,
    type FileResult,
    type MultiFileResult
} from '../tools/filesystem.js';

import { withTimeout } from '../utils.js';

import {
    ReadFileArgsSchema,
    ReadMultipleFilesArgsSchema,
    WriteFileArgsSchema,
    CreateDirectoryArgsSchema,
    ListDirectoryArgsSchema,
    MoveFileArgsSchema,
    SearchFilesArgsSchema,
    GetFileInfoArgsSchema
} from '../tools/schemas.js';

/**
 * Handle read_file command
 */
export async function handleReadFile(args: unknown) {
    const parsed = ReadFileArgsSchema.parse(args);
    // Explicitly cast the result to FileResult since we're passing true
    const fileResult = await readFile(parsed.path, true, parsed.isUrl) as FileResult;
    
    if (fileResult.isImage) {
        // For image files, return as an image content type
        return {
            content: [
                { 
                    type: "text", 
                    text: `Image file: ${parsed.path} (${fileResult.mimeType})\n` 
                },
                {
                    type: "image",
                    data: fileResult.content,
                    mimeType: fileResult.mimeType
                }
            ],
        };
    } else {
        // For all other files, return as text
        return {
            content: [{ type: "text", text: fileResult.content }],
        };
    }
}

/**
 * Handle read_multiple_files command
 */
export async function handleReadMultipleFiles(args: unknown) {
    const parsed = ReadMultipleFilesArgsSchema.parse(args);
    const fileResults = await readMultipleFiles(parsed.paths);
    
    // Create a text summary of all files
    const textSummary = fileResults.map(result => {
        if (result.error) {
            return `${result.path}: Error - ${result.error}`;
        } else if (result.mimeType) {
            return `${result.path}: ${result.mimeType} ${result.isImage ? '(image)' : '(text)'}`;
        } else {
            return `${result.path}: Unknown type`;
        }
    }).join("\n");
    
    // Create content items for each file
    const contentItems: Array<{type: string, text?: string, data?: string, mimeType?: string}> = [];
    
    // Add the text summary
    contentItems.push({ type: "text", text: textSummary });
    
    // Add each file content
    for (const result of fileResults) {
        if (!result.error && result.content !== undefined) {
            if (result.isImage && result.mimeType) {
                // For image files, add an image content item
                contentItems.push({
                    type: "image",
                    data: result.content,
                    mimeType: result.mimeType
                });
            } else {
                // For text files, add a text summary
                contentItems.push({
                    type: "text",
                    text: `\n--- ${result.path} contents: ---\n${result.content}`
                });
            }
        }
    }
    
    return { content: contentItems };
}

/**
 * Handle write_file command
 */
export async function handleWriteFile(args: unknown) {
    const parsed = WriteFileArgsSchema.parse(args);
    await writeFile(parsed.path, parsed.content);
    return {
        content: [{ type: "text", text: `Successfully wrote to ${parsed.path}` }],
    };
}

/**
 * Handle create_directory command
 */
export async function handleCreateDirectory(args: unknown) {
    const parsed = CreateDirectoryArgsSchema.parse(args);
    await createDirectory(parsed.path);
    return {
        content: [{ type: "text", text: `Successfully created directory ${parsed.path}` }],
    };
}

/**
 * Handle list_directory command
 */
export async function handleListDirectory(args: unknown) {
    const parsed = ListDirectoryArgsSchema.parse(args);
    const entries = await listDirectory(parsed.path);
    return {
        content: [{ type: "text", text: entries.join('\n') }],
    };
}

/**
 * Handle move_file command
 */
export async function handleMoveFile(args: unknown) {
    const parsed = MoveFileArgsSchema.parse(args);
    await moveFile(parsed.source, parsed.destination);
    return {
        content: [{ type: "text", text: `Successfully moved ${parsed.source} to ${parsed.destination}` }],
    };
}

/**
 * Handle search_files command
 */
export async function handleSearchFiles(args: unknown) {
    const parsed = SearchFilesArgsSchema.parse(args);
    const timeoutMs = parsed.timeoutMs || 30000; // 30 seconds default
    
    // Apply timeout at the handler level
    const searchOperation = async () => {
        return await searchFiles(parsed.path, parsed.pattern);
    };
    
    // Use withTimeout at the handler level
    const results = await withTimeout(
        searchOperation(),
        timeoutMs,
        'File search operation',
        [] // Empty array as default on timeout
    );
    
    if (results.length === 0) {
        // Similar approach as in handleSearchCode
        if (timeoutMs > 0) {
            return {
                content: [{ type: "text", text: `No matches found or search timed out after ${timeoutMs}ms.` }],
            };
        }
        return {
            content: [{ type: "text", text: "No matches found" }],
        };
    }
    
    return {
        content: [{ type: "text", text: results.join('\n') }],
    };
}

/**
 * Handle get_file_info command
 */
export async function handleGetFileInfo(args: unknown) {
    const parsed = GetFileInfoArgsSchema.parse(args);
    const info = await getFileInfo(parsed.path);
    return {
        content: [{ 
            type: "text", 
            text: Object.entries(info)
                .map(([key, value]) => `${key}: ${value}`)
                .join('\n') 
        }],
    };
}

/**
 * Handle list_allowed_directories command
 */
export function handleListAllowedDirectories() {
    const directories = listAllowedDirectories();
    return {
        content: [{ 
            type: "text", 
            text: `Allowed directories:\n${directories.join('\n')}` 
        }],
    };
}
