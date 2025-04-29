import { readFile, writeFile } from './filesystem.js';
import { ServerResult } from '../types.js';
import { recursiveFuzzyIndexOf, getSimilarityRatio } from './fuzzySearch.js';
import { capture } from '../utils.js';
import { EditBlockArgsSchema } from "./schemas.js";
import path from 'path';

interface SearchReplace {
    search: string;
    replace: string;
}

interface FuzzyMatch {
    start: number;
    end: number;
    value: string;
    distance: number;
    similarity: number;
}

/**
 * Threshold for fuzzy matching - similarity must be at least this value to be considered
 * (0-1 scale where 1 is perfect match and 0 is completely different)
 */
const FUZZY_THRESHOLD = 0.7;

export async function performSearchReplace(filePath: string, block: SearchReplace, expectedReplacements: number = 1): Promise<ServerResult> {
    // Check for empty search string to prevent infinite loops
    if (block.search === "") {
        return {
            content: [{ 
                type: "text", 
                text: "Empty search strings are not allowed. Please provide a non-empty string to search for."
            }],
        };
    }
    
    // Get file extension for telemetry using path module
    const fileExtension = path.extname(filePath).toLowerCase();
    
    // Capture file extension in telemetry without capturing the file path
    capture('server_edit_block', {fileExtension: fileExtension});

    // Read file as plain string
    const {content} = await readFile(filePath);
    
    // Make sure content is a string
    if (typeof content !== 'string') {
        throw new Error('Wrong content for file ' + filePath);
    }
    
    // First try exact match
    let tempContent = content;
    let count = 0;
    let pos = tempContent.indexOf(block.search);
    
    while (pos !== -1) {
        count++;
        pos = tempContent.indexOf(block.search, pos + 1);
    }
    
    // If exact match found and count matches expected replacements, proceed with exact replacement
    if (count > 0 && count === expectedReplacements) {
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
    
    // If exact match found but count doesn't match expected, inform the user
    if (count > 0 && count !== expectedReplacements) {
        return {
            content: [{ 
                type: "text", 
                text: `Expected ${expectedReplacements} occurrences but found ${count} in ${filePath}. ` + 
            `Double check and make sure you understand all occurencies and if you want to replace all ${count} occurrences, set expected_replacements to ${count}. ` +
            `If there are many occurrancies and you want to change some of them and keep the rest. Do it one by one, by adding more lines around each occurrence.` +
`If you want to replace a specific occurrence, make your search string more unique by adding more lines around search string.`
            }],
        };
    }
    
    // If exact match not found, try fuzzy search
    if (count === 0) {
        // Track fuzzy search time
        const startTime = performance.now();
        
        // Perform fuzzy search
        const fuzzyResult = recursiveFuzzyIndexOf(content, block.search);
        const similarity = getSimilarityRatio(block.search, fuzzyResult.value);
        
        // Calculate execution time in milliseconds
        const executionTime = performance.now() - startTime;
        
        // Check if the fuzzy match is "close enough"
        if (similarity >= FUZZY_THRESHOLD) {
            // Format differences for clearer output
            const diff = highlightDifferences(block.search, fuzzyResult.value);
            
            // Capture the fuzzy search event
            capture('server_fuzzy_search_performed', {
                similarity: similarity,
                execution_time_ms: executionTime,
                search_length: block.search.length,
                file_size: content.length,
                threshold: FUZZY_THRESHOLD,
                found_text_length: fuzzyResult.value.length
            });
            
            // If we allow fuzzy matches, we would make the replacement here
            // For now, we'll return a detailed message about the fuzzy match
            return {
                content: [{ 
                    type: "text", 
                    text: `Exact match not found, but found a similar text with ${Math.round(similarity * 100)}% similarity (found in ${executionTime.toFixed(2)}ms):\n\n` +
                          `Differences:\n${diff}\n\n` +
                          `To replace this text, use the exact text found in the file.`
                }],
            };
        } else {
            // If the fuzzy match isn't close enough
            // Still capture the fuzzy search event even for unsuccessful matches
            capture('server_fuzzy_search_performed', {
                similarity: similarity,
                execution_time_ms: executionTime,
                search_length: block.search.length,
                file_size: content.length,
                threshold: FUZZY_THRESHOLD,
                found_text_length: fuzzyResult.value.length,
                below_threshold: true
            });
            
            return {
                content: [{ 
                    type: "text", 
                    text: `Search content not found in ${filePath}. The closest match was "${fuzzyResult.value}" ` +
                          `with only ${Math.round(similarity * 100)}% similarity, which is below the ${Math.round(FUZZY_THRESHOLD * 100)}% threshold. ` +
                          `(Fuzzy search completed in ${executionTime.toFixed(2)}ms)`
                }],
            };
        }
    }
    
    throw new Error("Unexpected error during search and replace operation.");
}

/**
 * Generates a character-level diff using standard {-removed-}{+added+} format
 * @param expected The string that was searched for
 * @param actual The string that was found
 * @returns A formatted string showing character-level differences
 */
function highlightDifferences(expected: string, actual: string): string {
    // Implementation of a simplified character-level diff
    
    // Find common prefix and suffix
    let prefixLength = 0;
    const minLength = Math.min(expected.length, actual.length);

    // Determine common prefix length
    while (prefixLength < minLength &&
           expected[prefixLength] === actual[prefixLength]) {
        prefixLength++;
    }

    // Determine common suffix length
    let suffixLength = 0;
    while (suffixLength < minLength - prefixLength &&
           expected[expected.length - 1 - suffixLength] === actual[actual.length - 1 - suffixLength]) {
        suffixLength++;
    }
    
    // Extract the common and different parts
    const commonPrefix = expected.substring(0, prefixLength);
    const commonSuffix = expected.substring(expected.length - suffixLength);

    const expectedDiff = expected.substring(prefixLength, expected.length - suffixLength);
    const actualDiff = actual.substring(prefixLength, actual.length - suffixLength);

    // Format the output as a character-level diff
    return `${commonPrefix}{-${expectedDiff}-}{+${actualDiff}+}${commonSuffix}`;
}

/**
 * Handle edit_block command with enhanced functionality
 * - Supports multiple replacements
 * - Validates expected replacements count
 * - Provides detailed error messages
 */
export async function handleEditBlock(args: unknown): Promise<ServerResult> {
    const parsed = EditBlockArgsSchema.parse(args);
    
    const searchReplace = {
        search: parsed.old_string,
        replace: parsed.new_string
    };

    return performSearchReplace(parsed.file_path, searchReplace, parsed.expected_replacements);
}