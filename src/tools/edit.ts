import { readFile, writeFile } from './filesystem.js';
import { ServerResult } from '../types.js';

interface SearchReplaceFlags {
  global?: boolean;    // Replace all occurrences
  ignoreCase?: boolean; // Case-insensitive matching
  dryRun?: boolean;    // Don't apply changes, just simulate
  count?: number;      // Replace only N occurrences
}

interface SearchReplace {
  search: string;
  replace: string;
  flags?: SearchReplaceFlags;
}

// Enhanced result interface supporting multiple replacements and errors
interface EditBlockResult {
  filePath: string;
  searchReplace: SearchReplace[];
  errors?: {
    global?: string;          // Global error affecting all blocks
    blocks?: Array<{          // Block-specific errors
      index: number;          // Block index (0-based)
      lineNumber?: number;    // Line number in original content
      error: string;          // Error description
    }>;
  };
}

// Enhanced replacement result tracking
interface ReplacementResult {
  search: string;
  replace: string;
  applied: boolean;
  error?: string;        // Error message if this replacement failed
  count?: number;        // For global replacement, how many were replaced
  actualMatch?: string;  // For case-insensitive, what was actually matched
}

// Options for search/replace operation
interface SearchReplaceOptions {
  dryRun?: boolean; // Only simulate replacements without writing changes
}

// Maximum file and pattern size constraints
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_PATTERN_SIZE = 100 * 1024;    // 100KB

/**
 * Parse the edit block content with enhanced support for multiple blocks and flags
 * Maintains backward compatibility while supporting multiple search/replace pairs
 */
export async function parseEditBlock(blockContent: string): Promise<EditBlockResult> {
  const lines = blockContent.split('\n');
  
  // First line is always file path
  const filePath = lines[0].trim();
  
  // Initialize result array for multiple replacements
  const searchReplace: SearchReplace[] = [];
  const errors: EditBlockResult['errors'] = { blocks: [] };
  
  // Track the current parsing state
  let currentSearch = '';
  let currentReplace = '';
  let inSearchBlock = false;
  let inReplaceBlock = false;
  let currentBlockIndex = 0;
  let currentBlockStartLine = 0;
  let currentFlags: SearchReplaceFlags = {};
  
  // Parse line by line - this handles multiple blocks naturally
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    
    // Start of a search block
    if (line.startsWith('<<<<<<< SEARCH')) {
      if (inSearchBlock || inReplaceBlock) {
        errors.blocks?.push({
          index: currentBlockIndex,
          lineNumber: i,
          error: `Unexpected search block start while already in ${inSearchBlock ? 'search' : 'replace'} block`
        });
      }
      
      inSearchBlock = true;
      currentSearch = '';
      currentBlockStartLine = i;
      currentBlockIndex = searchReplace.length;
      
      // Parse flags if present
      currentFlags = { global: false, ignoreCase: false, dryRun: false };
      if (line.includes(':')) {
        const flagStr = line.split(':')[1].trim().toLowerCase();
        
        // Process each flag character
        for (let j = 0; j < flagStr.length; j++) {
          const flag = flagStr[j];
          
          // Handle standard single-char flags
          if (flag === 'g') currentFlags.global = true;
          if (flag === 'i') currentFlags.ignoreCase = true;
          if (flag === 'd') currentFlags.dryRun = true;
          
          // Handle n:X flag for counted replacements
          if (flag === 'n' && j < flagStr.length - 2 && flagStr[j+1] === ':') {
            // Extract the number after n:
            const numberMatch = flagStr.substring(j+2).match(/^\d+/);
            if (numberMatch) {
              const count = parseInt(numberMatch[0], 10);
              if (!isNaN(count) && count > 0) {
                currentFlags.count = count;
                // Skip past the number characters
                j += 1 + numberMatch[0].length;
              } else {
                errors.blocks?.push({
                  index: currentBlockIndex,
                  lineNumber: i,
                  error: `Invalid replacement count in n:X flag: "${numberMatch[0]}"`
                });
              }
            }
          }
        }
      }
    } 
    // Divider between search and replace
    else if (line === '=======' && inSearchBlock) {
      inSearchBlock = false;
      inReplaceBlock = true;
      currentReplace = '';
    } 
    // End of a replace block
    else if (line === '>>>>>>> REPLACE' && inReplaceBlock) {
      inReplaceBlock = false;
      // Add the completed search/replace pair to the result
      searchReplace.push({
        search: currentSearch,
        replace: currentReplace,
        flags: currentFlags
      });
    } 
    // Content within search block
    else if (inSearchBlock) {
      currentSearch += (currentSearch ? '\n' : '') + line;
    } 
    // Content within replace block
    else if (inReplaceBlock) {
      currentReplace += (currentReplace ? '\n' : '') + line;
    }
  }
  
  // Final validation
  if (inSearchBlock || inReplaceBlock) {
    errors.blocks?.push({
      index: currentBlockIndex,
      lineNumber: lines.length,
      error: `Unclosed ${inSearchBlock ? 'search' : 'replace'} block at end of content`
    });
  }
  
  // Validation
  if (searchReplace.length === 0) {
    errors.global = 'No valid search/replace blocks found in input';
    return {
      filePath,
      searchReplace: [],
      errors
    };
  }
  
  // Only include errors field if we have errors
  if (errors.blocks?.length === 0 && !errors.global) {
    return { filePath, searchReplace };
  }
  
  return { filePath, searchReplace, errors };
}

/**
 * Helper to escape regular expression special characters
 */
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Perform multiple search/replace operations with extended capabilities
 * Maintains identical behavior for single blocks while supporting multiple blocks and options
 */
export async function performSearchReplace(
  filePath: string, 
  blocksOrBlock: SearchReplace[] | SearchReplace,
  options: SearchReplaceOptions = {}
): Promise<ServerResult> {
  // Convert single block to array for unified processing
  const blocks = Array.isArray(blocksOrBlock) ? blocksOrBlock : [blocksOrBlock];
  
  // Extract global options (if provided at the operation level)
  const globalDryRun = options.dryRun || false;
  
  // Read file content
  const { content } = await readFile(filePath);
  
  // Ensure content is a string
  if (typeof content !== 'string') {
    throw new Error(`Wrong content type for file ${filePath}`);
  }

  // Validate file size
  if (content.length > MAX_FILE_SIZE) {
    return {
      content: [{ 
        type: "text", 
        text: `Error: File ${filePath} exceeds maximum size (${content.length} > ${MAX_FILE_SIZE} bytes)` 
      }],
    };
  }
  
  // Initialize tracking variables
  let newContent = content;
  let totalReplacements = 0;
  const replacementSummary: ReplacementResult[] = [];
  
  // Process each search/replace pair sequentially with enhanced error handling
  for (const block of blocks) {
    try {
      const { search, replace, flags = {} } = block;
      
      // Combine block-level flags with operation-level options
      const effectiveDryRun = flags.dryRun || globalDryRun;
      
      // Validate search pattern length
      if (search.length > MAX_PATTERN_SIZE) {
        replacementSummary.push({ 
          search, 
          replace, 
          applied: false,
          error: `Search pattern exceeds maximum length (${search.length} > ${MAX_PATTERN_SIZE})`
        });
        continue;
      }
      
      // Handle counted replacements (n:X flag)
      if (flags.count !== undefined && flags.count > 0) {
        const searchRegex = flags.ignoreCase 
          ? new RegExp(escapeRegExp(search), 'gi') 
          : new RegExp(escapeRegExp(search), 'g');
        
        let replacementCount = 0;
        let match: RegExpExecArray | null;
        let lastIndex = 0;
        let resultContent = '';
        
        // Build the result content by replacing only up to the specified count
        while ((match = searchRegex.exec(newContent)) !== null && replacementCount < flags.count) {
          // Add content up to the match
          resultContent += newContent.substring(lastIndex, match.index);
          // Add the replacement instead of the matched text
          resultContent += replace;
          // Move lastIndex past this match
          lastIndex = match.index + match[0].length;
          // Increment count
          replacementCount++;
          
          // Prevent infinite loops with zero-length matches
          if (match.index === searchRegex.lastIndex) {
            searchRegex.lastIndex++;
          }
        }
        
        // Add any remaining content after the last replacement
        if (lastIndex < newContent.length) {
          resultContent += newContent.substring(lastIndex);
        }
        
        // Update content
        newContent = resultContent;
        
        // Track the result
        totalReplacements += replacementCount;
        replacementSummary.push({ 
          search, 
          replace, 
          applied: replacementCount > 0,
          count: replacementCount
        });
      }
      // If global replacement is enabled
      else if (flags.global) {
        // Create regex with appropriate flags
        const searchRegex = flags.ignoreCase 
          ? new RegExp(escapeRegExp(search), 'gi') 
          : new RegExp(escapeRegExp(search), 'g');
        
        // Make a copy for comparison
        const originalContent = newContent;
        
        // Apply the replacement
        newContent = newContent.replace(searchRegex, replace);
        
        // Count replacements by comparing with regex
        const replacementCount = (originalContent.match(searchRegex) || []).length;
        totalReplacements += replacementCount;
        
        // Track the result
        replacementSummary.push({ 
          search, 
          replace, 
          applied: replacementCount > 0,
          count: replacementCount
        });
      } 
      // Case-insensitive search (without global flag)
      else if (flags.ignoreCase) {
        // Find the first case-insensitive match
        const lowerContent = newContent.toLowerCase();
        const lowerSearch = search.toLowerCase();
        const searchIndex = lowerContent.indexOf(lowerSearch);
        
        if (searchIndex === -1) {
          replacementSummary.push({ search, replace, applied: false });
          continue;
        }
        
        // Extract the actual matched text (preserving original case)
        const actualMatch = newContent.substring(searchIndex, searchIndex + search.length);
        
        // Apply the replacement
        newContent = 
          newContent.substring(0, searchIndex) + 
          replace + 
          newContent.substring(searchIndex + search.length);
        
        // Track the result
        replacementSummary.push({ 
          search, 
          replace, 
          applied: true,
          actualMatch,
          count: 1
        });
        totalReplacements++;
      } 
      // Original behavior - exact match, first occurrence only
      else {
        // Find first occurrence of this search text
        const searchIndex = newContent.indexOf(search);
        
        // If not found, track it but continue with others
        if (searchIndex === -1) {
          replacementSummary.push({ search, replace, applied: false });
          continue;
        }
        
        // Apply the replacement
        newContent = 
          newContent.substring(0, searchIndex) + 
          replace + 
          newContent.substring(searchIndex + search.length);
        
        // Track the successful replacement
        replacementSummary.push({ 
          search, 
          replace, 
          applied: true,
          count: 1
        });
        totalReplacements++;
      }
    } catch (error) {
      // Capture specific errors for each block
      replacementSummary.push({ 
        search: block.search, 
        replace: block.replace, 
        applied: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  
  // If no replacements were made at all, return informative message
  if (totalReplacements === 0) {
    // For backward compatibility, return the exact same message as the original
    if (blocks.length === 1) {
      return {
        content: [{ type: "text", text: `Search content not found in ${filePath}.` }],
      };
    }
    
    return {
      content: [{ type: "text", text: `No matches found in ${filePath} for any search patterns.` }],
    };
  }
  
  // If not dry run, apply the changes to the file
  if (!globalDryRun && totalReplacements > 0) {
    await writeFile(filePath, newContent);
  }
  
  // Generate result message
  // For backward compatibility with single block
  if (blocks.length === 1 && replacementSummary[0].applied && !globalDryRun) {
    return {
      content: [{ type: "text", text: `Successfully applied edit to ${filePath}` }],
    };
  }
  
  // Enhanced message for multiple blocks or dry run
  let resultText = globalDryRun ? '[DRY RUN] ' : '';
  resultText += `Successfully applied ${totalReplacements} replacement${totalReplacements !== 1 ? 's' : ''} to ${filePath}:`;
  
  replacementSummary.forEach(summary => {
    if (summary.applied) {
      let details = `\n- '${truncateForDisplay(summary.search)}' -> '${truncateForDisplay(summary.replace)}'`;
      if (summary.count && summary.count > 1) {
        details += ` (${summary.count} occurrences)`;
      }
      if (summary.actualMatch && summary.actualMatch !== summary.search) {
        details += ` (matched: '${truncateForDisplay(summary.actualMatch)}')`;
      }
      resultText += details;
    } else {
      let details = `\n- '${truncateForDisplay(summary.search)}' (not found)`;
      if (summary.error) {
        details += `: ${summary.error}`;
      }
      resultText += details;
    }
  });
  
  return {
    content: [{ type: "text", text: resultText }],
  };
}

/**
 * Helper to truncate long strings for display
 */
function truncateForDisplay(str: string, maxLength: number = 50): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - 3) + '...';
}
