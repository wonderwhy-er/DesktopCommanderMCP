import { readFile, writeFile } from './filesystem.js';

interface SearchReplace {
    search: string;
    replace: string;
}

export async function performSearchReplace(filePath: string, block: SearchReplace): Promise<void> {
    // Read file as plain string (don't pass true to get just the string)
    const content = await readFile(filePath);
    
    // Make sure content is a string
    const contentStr = typeof content === 'string' ? content : content.content;
    
    // Find first occurrence
    const searchIndex = contentStr.indexOf(block.search);
    if (searchIndex === -1) {
        throw new Error(`Search content not found in ${filePath}`);
    }

    // Replace content
    const newContent = 
        contentStr.substring(0, searchIndex) + 
        block.replace + 
        contentStr.substring(searchIndex + block.search.length);

    await writeFile(filePath, newContent);
}

export async function parseEditBlock(blockContent: string): Promise<{
    filePath: string;
    searchReplace: SearchReplace;
}> {
    const lines = blockContent.split('\n');
    
    // First line should be the file path
    const filePath = lines[0].trim();
    
    // Find the markers
    const searchStart = lines.indexOf('<<<<<<< SEARCH');
    const divider = lines.indexOf('=======');
    const replaceEnd = lines.indexOf('>>>>>>> REPLACE');
    
    if (searchStart === -1 || divider === -1 || replaceEnd === -1) {
        throw new Error('Invalid edit block format - missing markers');
    }
    
    // Extract search and replace content
    const search = lines.slice(searchStart + 1, divider).join('\n');
    const replace = lines.slice(divider + 1, replaceEnd).join('\n');
    
    return {
        filePath,
        searchReplace: { search, replace }
    };
}