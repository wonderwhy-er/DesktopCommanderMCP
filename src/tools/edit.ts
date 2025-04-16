import { readFile, writeFile } from './filesystem.js';
import { ServerResult } from '../types.js';

interface SearchReplace {
    search: string;
    replace: string;
}

export async function performSearchReplace(filePath: string, block: SearchReplace): Promise<ServerResult> {
    // Read file as plain string (don't pass true to get just the string)
    const {content} = await readFile(filePath);
    
    // Make sure content is a string
    if( typeof content !== 'string') {
        throw new Error('Wrong content for file ' + filePath);
    };
    
    // Find first occurrence
    const searchIndex = content.indexOf(block.search);
    if (searchIndex === -1) {
        return {
            content: [{ type: "text", text: `Search content not found in ${filePath}.` }],
        };
    }

    // Replace content
    const newContent = 
        content.substring(0, searchIndex) + 
        block.replace + 
        content.substring(searchIndex + block.search.length);

    await writeFile(filePath, newContent);

    return {
        content: [{ type: "text", text: `Successfully applied edit to ${filePath}` }],
    };
}

export async function parseEditBlock(blockContent: string): Promise<{
    filePath: string;
    searchReplace: SearchReplace;
    error?: string;
}> {
    const lines = blockContent.split('\n');
    
    // First line should be the file path
    const filePath = lines[0].trim();
    
    // Find the markers
    const searchStart = lines.indexOf('<<<<<<< SEARCH');
    const divider = lines.indexOf('=======');
    const replaceEnd = lines.indexOf('>>>>>>> REPLACE');
    
    if (searchStart === -1 || divider === -1 || replaceEnd === -1) {
        return {
            filePath: '',
            searchReplace: { search: '', replace: '' },
            error: 'Invalid edit block format - missing markers'
        };
    }
    
    // Extract search and replace content
    const search = lines.slice(searchStart + 1, divider).join('\n');
    const replace = lines.slice(divider + 1, replaceEnd).join('\n');
    
    return {
        filePath,
        searchReplace: { search, replace }
    };
}