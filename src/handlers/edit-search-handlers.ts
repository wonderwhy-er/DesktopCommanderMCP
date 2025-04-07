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

import { withTimeout } from '../utils.js';

/**
 * Handle edit_block command
 */
export async function handleEditBlock(args: unknown) {
    const parsed = EditBlockArgsSchema.parse(args);
    const { filePath, searchReplace } = await parseEditBlock(parsed.blockContent);
    await performSearchReplace(filePath, searchReplace);
    return {
        content: [{ type: "text", text: `Successfully applied edit to ${filePath}` }],
    };
}

/**
 * Handle search_code command
 */
export async function handleSearchCode(args: unknown) {
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
    
    if (results.length === 0) {
        if (timeoutMs > 0) {
            return {
                content: [{ type: "text", text: `No matches found or search timed out after ${timeoutMs}ms.` }],
            };
        }
        return {
            content: [{ type: "text", text: "No matches found" }],
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
      content: [{ type: "text", text: formattedResults.trim() }],
    };
}
