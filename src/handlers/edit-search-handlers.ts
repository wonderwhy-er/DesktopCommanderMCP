import {
    parseEditBlock,
    performSearchReplace
} from '../tools/edit.js';

import {
    searchTextInFiles
} from '../tools/search.js';

import {
    EditBlockArgsSchema,
    SearchCodeArgsSchema
} from '../tools/schemas.js';

import {ServerResult} from '../types.js';
import {capture, withTimeout} from '../utils.js';
import {createErrorResponse} from '../error-handlers.js';

/**
 * Handle edit_block command with enhanced capabilities
 */
export async function handleEditBlock(args: unknown): Promise<ServerResult> {
    try {
        // Parse input arguments
        const parsed = EditBlockArgsSchema.parse(args);
        
        // Parse the block content (enhanced implementation)
        const { filePath, searchReplace, errors } = await parseEditBlock(parsed.blockContent);
        
        // Handle parsing errors
        if (errors?.global) {
            return createErrorResponse(errors.global);
        }
        
        // Report block-specific errors if present
        if (errors?.blocks && errors.blocks.length > 0) {
            const errorMessages = errors.blocks.map(error => 
                `Block ${error.index + 1}${error.lineNumber ? ` (line ${error.lineNumber})` : ''}: ${error.error}`
            ).join('\n');
            
            return createErrorResponse(`Parse errors in edit blocks:\n${errorMessages}`);
        }
        
        // Use enhanced implementation for all replacements
        return await performSearchReplace(filePath, searchReplace);
    } catch (error) {
        // Maintain existing error handling
        const errorMessage = error instanceof Error ? error.message : String(error);
        return createErrorResponse(errorMessage);
    }
}

/**
 * Handle search_code command
 */
export async function handleSearchCode(args: unknown): Promise<ServerResult> {
    const parsed = SearchCodeArgsSchema.parse(args);
    const timeoutMs = parsed.timeoutMs || 30000; // 30 seconds default

    // Apply timeout at the handler level
    const searchOperation = async () => {
        return await searchTextInFiles({
            rootPath: parsed.path,
            pattern: parsed.pattern,
            filePattern: parsed.filePattern,
            ignoreCase: parsed.ignoreCase,
            maxResults: parsed.maxResults,
            includeHidden: parsed.includeHidden,
            contextLines: parsed.contextLines,
            // Don't pass timeoutMs down to the implementation
        });
    };

    // Use withTimeout at the handler level
    const results = await withTimeout(
        searchOperation(),
        timeoutMs,
        'Code search operation',
        [] // Empty array as default on timeout
    );

    // If timeout occurred, try to terminate the ripgrep process
    if (results.length === 0 && (globalThis as any).currentSearchProcess) {
        try {
            console.log(`Terminating timed out search process (PID: ${(globalThis as any).currentSearchProcess.pid})`);
            (globalThis as any).currentSearchProcess.kill();
            delete (globalThis as any).currentSearchProcess;
        } catch (error) {
            capture('server_request_error', {
                error: 'Error terminating search process'
            });
        }
    }

    if (results.length === 0) {
        if (timeoutMs > 0) {
            return {
                content: [{type: "text", text: `No matches found or search timed out after ${timeoutMs}ms.`}],
            };
        }
        return {
            content: [{type: "text", text: "No matches found"}],
        };
    }

    // Format the results in a VS Code-like format
    let currentFile = "";
    let formattedResults = "";

    results.forEach(result => {
        if (result.file !== currentFile) {
            formattedResults += `\n${result.file}:\n`;
            currentFile = result.file;
        }
        formattedResults += `  ${result.line}: ${result.match}\n`;
    });

    return {
        content: [{type: "text", text: formattedResults.trim()}],
    };
}
