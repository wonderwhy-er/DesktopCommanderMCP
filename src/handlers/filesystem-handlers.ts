import {
    readFile,
    readMultipleFiles,
    writeFile,
    createDirectory,
    listDirectory,
    moveFile,
    getFileInfo,
    writePdf,
    type FileResult,
    type MultiFileResult
} from '../tools/filesystem.js';
import type { ReadOptions } from '../utils/files/base.js';

import { ServerResult } from '../types.js';
import { withTimeout } from '../utils/withTimeout.js';
import { createErrorResponse } from '../error-handlers.js';
import { configManager } from '../config-manager.js';

import {
    ReadFileArgsSchema,
    ReadMultipleFilesArgsSchema,
    WriteFileArgsSchema,
    CreateDirectoryArgsSchema,
    ListDirectoryArgsSchema,
    MoveFileArgsSchema,
    GetFileInfoArgsSchema,
    WritePdfArgsSchema
} from '../tools/schemas.js';

/**
 * Helper function to check if path contains an error
 */
function isErrorPath(path: string): boolean {
    return path.startsWith('__ERROR__:');
}

/**
 * Extract error message from error path
 */
function getErrorFromPath(path: string): string {
    return path.substring('__ERROR__:'.length).trim();
}

/**
 * Handle read_file command
 */
export async function handleReadFile(args: unknown): Promise<ServerResult> {
    const HANDLER_TIMEOUT = 60000; // 60 seconds total operation timeout
    // Add input validation
    if (args === null || args === undefined) {
        return createErrorResponse('No arguments provided for read_file command');
    }
    const readFileOperation = async () => {
        const parsed = ReadFileArgsSchema.parse(args);

        // Get the configuration for file read limits
        const config = await configManager.getConfig();
        if (!config) {
            return createErrorResponse('Configuration not available');
        }

        const defaultLimit = config.fileReadLineLimit ?? 1000;

        // Convert sheet parameter: numeric strings become numbers for Excel index access
        let sheetParam: string | number | undefined = parsed.sheet;
        if (parsed.sheet !== undefined && /^\d+$/.test(parsed.sheet)) {
            sheetParam = parseInt(parsed.sheet, 10);
        }

        const options: ReadOptions = {
            isUrl: parsed.isUrl,
            offset: parsed.offset ?? 0,
            length: parsed.length ?? defaultLimit,
            sheet: sheetParam,
            range: parsed.range
        };
        const fileResult = await readFile(parsed.path, options);

        // Handle PDF files
        if (fileResult.metadata?.isPdf) {
            const meta = fileResult.metadata;
            const author = meta?.author ? `, Author: ${meta?.author}` : "";
            const title = meta?.title ? `, Title: ${meta?.title}` : "";

            const pdfContent = fileResult.metadata?.pages?.flatMap((p: any) => [
                ...(p.images?.map((image: any) => ({
                    type: "image",
                    data: image.data,
                    mimeType: image.mimeType
                })) ?? []),
                {
                    type: "text",
                    text: `<!-- Page: ${p.pageNumber} -->\n${p.text}`,
                },
            ]) ?? [];

            return {
                content: [
                    {
                        type: "text",
                        text: `PDF file: ${parsed.path}${author}${title} (${meta?.totalPages} pages) \n`
                    },
                    ...pdfContent
                ]
            };
        }

        // Handle image files
        if (fileResult.metadata?.isImage) {
            // For image files, return as an image content type
            // Content should already be base64-encoded string from handler
            const imageData = typeof fileResult.content === 'string'
                ? fileResult.content
                : fileResult.content.toString('base64');
            return {
                content: [
                    {
                        type: "text",
                        text: `Image file: ${parsed.path} (${fileResult.mimeType})\n`
                    },
                    {
                        type: "image",
                        data: imageData,
                        mimeType: fileResult.mimeType
                    }
                ],
            };
        } else {
            // For all other files, return as text
            const textContent = typeof fileResult.content === 'string'
                ? fileResult.content
                : fileResult.content.toString('utf8');
            return {
                content: [{ type: "text", text: textContent }],
            };
        }
    };

    // Execute with timeout at the handler level
    const result = await withTimeout(
        readFileOperation(),
        HANDLER_TIMEOUT,
        'Read file handler operation',
        null
    );
    if (result == null) {
        // Handles the impossible case where withTimeout resolves to null instead of throwing
        throw new Error('Failed to read the file');
    }
    return result;
}

/**
 * Handle read_multiple_files command
 */
export async function handleReadMultipleFiles(args: unknown): Promise<ServerResult> {
    const parsed = ReadMultipleFilesArgsSchema.parse(args);
    const fileResults = await readMultipleFiles(parsed.paths);

    // Create a text summary of all files
    const textSummary = fileResults.map(result => {
        if (result.error) {
            return `${result.path}: Error - ${result.error}`;
        } else if (result.isPdf) {
            return `${result.path}: PDF file with ${result.payload?.pages?.length} pages`;
        } else if (result.mimeType) {
            return `${result.path}: ${result.mimeType} ${result.isImage ? '(image)' : '(text)'}`;
        } else {
            return `${result.path}: Unknown type`;
        }
    }).join("\n");

    // Create content items for each file
    const contentItems: Array<{ type: string, text?: string, data?: string, mimeType?: string }> = [];

    // Add the text summary
    contentItems.push({ type: "text", text: textSummary });

    // Add each file content
    for (const result of fileResults) {
        if (!result.error && result.content !== undefined) {
            if (result.isPdf) {
                result.payload?.pages.forEach((page, i) => {
                    page.images.forEach((image, i) => {
                        contentItems.push({
                            type: "image",
                            data: image.data,
                            mimeType: image.mimeType
                        });
                    });
                    contentItems.push({
                        type: "text",
                        text: page.text,
                    });
                });
            } else if (result.isImage && result.mimeType) {
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
export async function handleWriteFile(args: unknown): Promise<ServerResult> {
    try {
        const parsed = WriteFileArgsSchema.parse(args);

        // Get the line limit from configuration
        const config = await configManager.getConfig();
        const MAX_LINES = config.fileWriteLineLimit ?? 50; // Default to 50 if not set

        // Strictly enforce line count limit
        const lines = parsed.content.split('\n');
        const lineCount = lines.length;
        let errorMessage = "";
        if (lineCount > MAX_LINES) {
            errorMessage = `✅ File written successfully! (${lineCount} lines)
            
💡 Performance tip: For optimal speed, consider chunking files into ≤30 line pieces in future operations.`;
        }

        // Pass the mode parameter to writeFile
        await writeFile(parsed.path, parsed.content, parsed.mode);

        // Provide more informative message based on mode
        const modeMessage = parsed.mode === 'append' ? 'appended to' : 'wrote to';

        return {
            content: [{
                type: "text",
                text: `Successfully ${modeMessage} ${parsed.path} (${lineCount} lines) ${errorMessage}`
            }],
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return createErrorResponse(errorMessage);
    }
}

/**
 * Handle create_directory command
 */
export async function handleCreateDirectory(args: unknown): Promise<ServerResult> {
    try {
        const parsed = CreateDirectoryArgsSchema.parse(args);
        await createDirectory(parsed.path);
        return {
            content: [{ type: "text", text: `Successfully created directory ${parsed.path}` }],
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return createErrorResponse(errorMessage);
    }
}

/**
 * Handle list_directory command
 */
export async function handleListDirectory(args: unknown): Promise<ServerResult> {
    try {
        const startTime = Date.now();
        const parsed = ListDirectoryArgsSchema.parse(args);
        const entries = await listDirectory(parsed.path, parsed.depth);
        const duration = Date.now() - startTime;

        const resultText = entries.join('\n');

        return {
            content: [{ type: "text", text: resultText }],
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return createErrorResponse(errorMessage);
    }
}

/**
 * Handle move_file command
 */
export async function handleMoveFile(args: unknown): Promise<ServerResult> {
    try {
        const parsed = MoveFileArgsSchema.parse(args);
        await moveFile(parsed.source, parsed.destination);
        return {
            content: [{ type: "text", text: `Successfully moved ${parsed.source} to ${parsed.destination}` }],
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return createErrorResponse(errorMessage);
    }
}

/**
 * Format a value for display, handling objects and arrays
 */
function formatValue(value: unknown, indent: string = ''): string {
    if (value === null || value === undefined) {
        return String(value);
    }
    if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        // For arrays of objects (like sheets), format each item
        const items = value.map((item, i) => {
            if (typeof item === 'object' && item !== null) {
                const props = Object.entries(item)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(', ');
                return `${indent}  [${i}] { ${props} }`;
            }
            return `${indent}  [${i}] ${item}`;
        });
        return `\n${items.join('\n')}`;
    }
    if (typeof value === 'object') {
        return JSON.stringify(value);
    }
    return String(value);
}

/**
 * Handle get_file_info command
 */
export async function handleGetFileInfo(args: unknown): Promise<ServerResult> {
    try {
        const parsed = GetFileInfoArgsSchema.parse(args);
        const info = await getFileInfo(parsed.path);

        // Generic formatting for any file type
        const formattedText = Object.entries(info)
            .map(([key, value]) => `${key}: ${formatValue(value)}`)
            .join('\n');

        return {
            content: [{
                type: "text",
                text: formattedText
            }],
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return createErrorResponse(errorMessage);
    }
}

// Use get_config to retrieve the allowedDirectories configuration

/**
 * Handle write_pdf command
 */
export async function handleWritePdf(args: unknown): Promise<ServerResult> {
    try {
        const parsed = WritePdfArgsSchema.parse(args);
        await writePdf(parsed.path, parsed.content, parsed.outputPath, parsed.options);
        const targetPath = parsed.outputPath || parsed.path;
        return {
            content: [{ type: "text", text: `Successfully wrote PDF to ${targetPath}${parsed.outputPath ? `\nOriginal file: ${parsed.path}` : ''}` }],
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return createErrorResponse(errorMessage);
    }
}
