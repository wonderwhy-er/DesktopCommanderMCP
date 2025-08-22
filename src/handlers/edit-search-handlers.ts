import {
    searchTextInFiles
} from '../tools/search.js';

import {
    SearchCodeArgsSchema,
    EditBlockArgsSchema
} from '../tools/schemas.js';

import { handleEditBlock } from '../tools/edit.js';

import { ServerResult } from '../types.js';
import { capture } from '../utils/capture.js';
import { withTimeout } from '../utils/withTimeout.js';

/**
 * Handle edit_block command
 * Uses the enhanced implementation with multiple occurrence support and fuzzy matching
 */
export { handleEditBlock };

/**
 * Handle search_code command
 */
export async function handleSearchCode(args: unknown): Promise<ServerResult> {
    const parsed = SearchCodeArgsSchema.parse(args);
    const timeoutMs = parsed.timeoutMs || 30000; // 30 seconds default

    // Limit maxResults to prevent overwhelming responses
    const safeMaxResults = parsed.maxResults ? Math.min(parsed.maxResults, 5000) : 2000; // Default to 2000 instead of 1000

    // Apply timeout at the handler level
    const searchOperation = async () => {
        return await searchTextInFiles({
            rootPath: parsed.path,
            pattern: parsed.pattern,
            filePattern: parsed.filePattern,
            ignoreCase: parsed.ignoreCase,
            maxResults: safeMaxResults,
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

    // Format the results in a VS Code-like format with early truncation
    let currentFile = "";
    let formattedResults = "";
    const MAX_RESPONSE_SIZE = 900000; // 900KB limit - well below the 1MB API limit
    let resultsProcessed = 0;
    let totalResults = results.length;

    for (const result of results) {
        // Check if adding this result would exceed our limit
        const newFileHeader = result.file !== currentFile ? `\n${result.file}:\n` : '';
        const newLine = `  ${result.line}: ${result.match}\n`;
        const potentialAddition = newFileHeader + newLine;
        
        // If adding this would exceed the limit, truncate here
        if (formattedResults.length + potentialAddition.length > MAX_RESPONSE_SIZE) {
            const remainingResults = totalResults - resultsProcessed;
            const avgResultLength = formattedResults.length / Math.max(resultsProcessed, 1);
            const estimatedRemainingChars = remainingResults * avgResultLength;
            const truncationMessage = `\n\n[Results truncated - ${remainingResults} more results available (approximately ${Math.round(estimatedRemainingChars).toLocaleString()} more characters). Try refining your search pattern or using a more specific file pattern to get fewer results.]`;
            formattedResults += truncationMessage;
            break;
        }
        
        if (result.file !== currentFile) {
            formattedResults += newFileHeader;
            currentFile = result.file;
        }
        formattedResults += newLine;
        resultsProcessed++;
    }

    return {
        content: [{type: "text", text: formattedResults.trim()}],
    };
}