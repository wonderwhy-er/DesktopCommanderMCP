import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { validatePath } from './filesystem.js';
import { rgPath } from '@vscode/ripgrep';

// Type definition for search results
export interface SearchResult {
  file: string;
  line: number;
  match: string;
}

// Function to calculate Levenshtein distance
function levenshtein(a: string, b: string): number {
  const matrix = Array.from({ length: a.length + 1 }, () =>
    Array(b.length + 1).fill(0)
  );

  for (let i = 0; i <= a.length; i++) {
    matrix[i][0] = i;
  }

  for (let j = 0; j <= b.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + 1
        );
      }
    }
  }

  return matrix[a.length][b.length];
}

// Function to search file contents using ripgrep
export async function searchCode(options: {
  rootPath: string,        // Directory to search in
  pattern: string,         // Text/regex pattern to search for
  filePattern?: string,    // Optional file pattern (e.g., "*.ts")
  ignoreCase?: boolean,    // Case insensitive search
  maxResults?: number,     // Limit number of results
  includeHidden?: boolean, // Whether to include hidden files
  contextLines?: number,   // Number of context lines before and after matches
  fuzzy?: boolean,         // Enable fuzzy search
}): Promise<SearchResult[]> {
  const { 
    rootPath, 
    pattern, 
    filePattern, 
    ignoreCase = true, 
    maxResults = 1000, 
    includeHidden = false,
    contextLines = 0,
    fuzzy = false
  } = options;
  
  // Validate path for security
  const validPath = await validatePath(rootPath);
  
  // Build command arguments
  const args = [
    '--json',  // Output in JSON format for easier parsing
    '--line-number', // Include line numbers
  ];
  
  if (ignoreCase) {
    args.push('-i');
  }
  
  if (maxResults) {
    args.push('-m', maxResults.toString());
  }
  
  if (includeHidden) {
    args.push('--hidden');
  }
  
  if (contextLines > 0) {
    args.push('-C', contextLines.toString());
  }
  
  if (filePattern) {
    args.push('-g', filePattern);
  }
  
  // Add pattern and path
  args.push(pattern, validPath);
  
  // Run ripgrep command
  return new Promise((resolve, reject) => {
    const results: SearchResult[] = [];
    const rg = spawn(rgPath, args);
    let stdoutBuffer = '';
    
    rg.stdout.on('data', (data) => {
      stdoutBuffer += data.toString();
    });
    
    rg.stderr.on('data', (data) => {
      console.error(`ripgrep error: ${data}`);
    });
    
    rg.on('close', (code) => {
      if (code === 0 || code === 1) {
        // Process the buffered output
        const lines = stdoutBuffer.trim().split('\n');
        for (const line of lines) {
          if (!line) continue;
          try {
            const result = JSON.parse(line);
            if (result.type === 'match') {
              result.data.submatches.forEach((submatch: any) => {
                results.push({
                  file: result.data.path.text,
                  line: result.data.line_number,
                  match: submatch.match.text
                });
              });
            }

            else if (result.type === 'context' && contextLines > 0) {
              results.push({
                file: result.data.path.text,
                line: result.data.line_number,
                match: result.data.lines.text.trim()
              });
            }
          } catch (e) {
            // Skip non-JSON output
            console.error('Error parsing ripgrep output:', e);
          }
        }

        if (fuzzy) {
          // Apply fuzzy search logic
          const fuzzyResults = results.filter(result => {
            const distance = levenshtein(pattern, result.match);
            return distance <= Math.max(2, Math.floor(pattern.length / 4));
          });
          resolve(fuzzyResults);
        } else {
          resolve(results);
        }
      } else {
        reject(new Error(`ripgrep process exited with code ${code}`));
      }
    });
  });
}

// Fallback implementation using Node.js for environments without ripgrep
export async function searchCodeFallback(options: {
  rootPath: string,
  pattern: string,
  filePattern?: string,
  ignoreCase?: boolean,
  maxResults?: number,
  excludeDirs?: string[],
  contextLines?: number,
  fuzzy?: boolean,
}): Promise<SearchResult[]> {
  const { 
    rootPath, 
    pattern, 
    filePattern, 
    ignoreCase = true, 
    maxResults = 1000,
    excludeDirs = ['node_modules', '.git'],
    contextLines = 0,
    fuzzy = false
  } = options;
  
  const validPath = await validatePath(rootPath);
  const results: SearchResult[] = [];
  const regex = new RegExp(pattern, ignoreCase ? 'i' : '');
  const fileRegex = filePattern ? new RegExp(filePattern) : null;
  
  async function searchDir(dirPath: string) {
    if (results.length >= maxResults) return;
    
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      
      for (const entry of entries) {
        if (results.length >= maxResults) break;
        
        const fullPath = path.join(dirPath, entry.name);
        
        try {
          await validatePath(fullPath);
          
          if (entry.isDirectory()) {
            if (!excludeDirs.includes(entry.name)) {
              await searchDir(fullPath);
            }
          } else if (entry.isFile()) {
            if (!fileRegex || fileRegex.test(entry.name)) {
              const content = await fs.readFile(fullPath, 'utf-8');
              const lines = content.split('\n');
              
              for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i])) {
                  // Add the matched line
                  results.push({
                    file: fullPath,
                    line: i + 1,
                    match: lines[i].trim()
                  });
                  
                  // Add context lines
                  if (contextLines > 0) {
                    const startIdx = Math.max(0, i - contextLines);
                    const endIdx = Math.min(lines.length - 1, i + contextLines);
                    
                    for (let j = startIdx; j <= endIdx; j++) {
                      if (j !== i) { // Skip the match line as it's already added
                        results.push({
                          file: fullPath,
                          line: j + 1,
                          match: lines[j].trim()
                        });
                      }
                    }
                  }
                  
                  if (results.length >= maxResults) break;
                }
              }
            }
          }
        } catch (error) {
          // Skip files/directories we can't access
          continue;
        }
      }
    } catch (error) {
      // Skip directories we can't read
    }
  }
  
  await searchDir(validPath);

  if (fuzzy) {
    // Apply fuzzy search logic
    const fuzzyResults = results.filter(result => {
      const distance = levenshtein(pattern, result.match);
      return distance <= Math.max(2, Math.floor(pattern.length / 4));
    });
    return fuzzyResults;
  } else {
    return results;
  }
}

// Main function that tries ripgrep first, falls back to native implementation
export async function searchTextInFiles(options: {
  rootPath: string,
  pattern: string,
  filePattern?: string,
  ignoreCase?: boolean,
  maxResults?: number,
  includeHidden?: boolean,
  contextLines?: number,
  fuzzy?: boolean,
}): Promise<SearchResult[]> {
  try {
    return await searchCode(options);
  } catch (error) {
    console.error('Ripgrep search failed, falling back to native implementation:', error);
    return searchCodeFallback({
      ...options,
      excludeDirs: ['node_modules', '.git', 'dist']
    });
  }
}
