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
    const results = await searchTextInFiles({
        rootPath: parsed.path,
        pattern: parsed.pattern,
        filePattern: parsed.filePattern,
        ignoreCase: parsed.ignoreCase,
        maxResults: parsed.maxResults,
        includeHidden: parsed.includeHidden,
        contextLines: parsed.contextLines,
    });
    
    if (results.length === 0) {
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
