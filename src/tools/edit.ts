import { readFile, writeFile } from './filesystem.js';
import { ServerResult } from '../types.js';

interface SearchReplace {
    search: string;
    replace: string;
}

export async function performSearchReplace(filePath: string, block: SearchReplace, expectedReplacements: number = 1): Promise<ServerResult> {
    // Read file as plain string (don't pass true to get just the string)
    const {content} = await readFile(filePath);
    
    // Make sure content is a string
    if (typeof content !== 'string') {
        throw new Error('Wrong content for file ' + filePath);
    }
    
    // Count occurrences to check uniqueness or match expected replacements
    let tempContent = content;
    let count = 0;
    let pos = tempContent.indexOf(block.search);
    
    while (pos !== -1) {
        count++;
        pos = tempContent.indexOf(block.search, pos + 1);
    }
    
    // Check if we have the expected number of replacements
    if (count === 0) {
        return {
            content: [{ type: "text", text: `Search content not found in ${filePath}.` }],
        };
    } else if (count !== expectedReplacements) {
        return {
            content: [{ 
                type: "text", 
                text: `Expected ${expectedReplacements} occurrences but found ${count} in ${filePath}. ` + 
                      `If you want to replace all ${count} occurrences, set expected_replacements to ${count}. ` +
                      `If you want to replace a specific occurrence, make your search string more unique by adding context.` 
            }],
        };
    }
    
    // Replace all occurrences
    let newContent = content;
    
    // If we're only replacing one occurrence, replace it directly
    if (expectedReplacements === 1) {
        const searchIndex = newContent.indexOf(block.search);
        newContent = 
            newContent.substring(0, searchIndex) + 
            block.replace + 
            newContent.substring(searchIndex + block.search.length);
    } else {
        // Replace all occurrences using split and join for multiple replacements
        newContent = newContent.split(block.search).join(block.replace);
    }
    
    await writeFile(filePath, newContent);
    
    return {
        content: [{ 
            type: "text", 
            text: `Successfully applied ${expectedReplacements} edit${expectedReplacements > 1 ? 's' : ''} to ${filePath}` 
        }],
    };
}

// Function removed as it's no longer needed with direct parameter passing