import { spawn, ChildProcess } from 'child_process';
import { rgPath } from '@vscode/ripgrep';
import path from 'path';
import { validatePath } from './tools/filesystem.js';
import { capture } from './utils/capture.js';

export interface SearchResult {
  file: string;
  line?: number;
  match?: string;
  type: 'file' | 'content';
}

export interface SearchSession {
  id: string;
  process: ChildProcess;
  results: SearchResult[];
  isComplete: boolean;
  isError: boolean;
  error?: string;
  startTime: number;
  lastReadTime: number;
  options: SearchSessionOptions;
  buffer: string;  // For processing incomplete JSON lines
  totalMatches: number;
  totalContextLines: number;  // Track context lines separately
  wasIncomplete?: boolean;  // NEW: Track if search was incomplete due to permissions/access issues
}

export interface SearchSessionOptions {
  rootPath: string;
  pattern: string;
  searchType: 'files' | 'content';
  filePattern?: string;
  ignoreCase?: boolean;
  maxResults?: number;
  includeHidden?: boolean;
  contextLines?: number;
  timeout?: number;
  earlyTermination?: boolean;  // Stop search early when exact filename match is found
  literalSearch?: boolean;     // Force literal string matching (-F flag) instead of regex
}

/**
 * Search Session Manager - handles ripgrep processes like terminal sessions
 * Supports both file search and content search with progressive results
 */export class SearchManager {
  private sessions = new Map<string, SearchSession>();
  private sessionCounter = 0;

  /**
   * Start a new search session (like start_process)
   * Returns immediately with initial state and results
   */

  async startSearch(options: SearchSessionOptions): Promise<{
    sessionId: string;
    isComplete: boolean;
    isError: boolean;
    results: SearchResult[];
    totalResults: number;
    runtime: number;
  }> {
    const sessionId = `search_${++this.sessionCounter}_${Date.now()}`;
    
    // Validate path first
    const validPath = await validatePath(options.rootPath);

    // Build ripgrep arguments
    const args = this.buildRipgrepArgs({ ...options, rootPath: validPath });
    
    // Start ripgrep process
    const rgProcess = spawn(rgPath, args);
    
    if (!rgProcess.pid) {
      throw new Error('Failed to start ripgrep process');
    }

    // Create session
    const session: SearchSession = {
      id: sessionId,
      process: rgProcess,
      results: [],
      isComplete: false,
      isError: false,
      startTime: Date.now(),
      lastReadTime: Date.now(),
      options,
      buffer: '',
      totalMatches: 0,
      totalContextLines: 0
    };

    this.sessions.set(sessionId, session);

    // Set up process event handlers
    this.setupProcessHandlers(session);

    // Start cleanup interval now that we have a session
    startCleanupIfNeeded();

    // Set up timeout if specified and auto-terminate
    // For exact filename searches, use a shorter default timeout
    const timeoutMs = options.timeout ?? (this.isExactFilename(options.pattern) ? 1500 : undefined);
    
    let killTimer: NodeJS.Timeout | null = null;
    if (timeoutMs) {
      killTimer = setTimeout(() => {
        if (!session.isComplete && !session.process.killed) {
          session.process.kill('SIGTERM');
        }
      }, timeoutMs);
    }

    // Clear timer on process completion
    session.process.once('close', () => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    });

    session.process.once('error', () => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    });

    capture('search_session_started', {
      sessionId,
      searchType: options.searchType,
      hasTimeout: !!timeoutMs,
      timeoutMs,
      requestedPath: options.rootPath,
      validatedPath: validPath
    });

    // Wait for first chunk of data or early completion instead of fixed delay
    const firstChunk = new Promise<void>(resolve => {
      const onData = () => {
        session.process.stdout?.off('data', onData);
        resolve();
      };
      session.process.stdout?.once('data', onData);
      setTimeout(resolve, 40); // cap at 40ms instead of 50-100ms
    });
    await firstChunk;

    return {
      sessionId,
      isComplete: session.isComplete,
      isError: session.isError,
      results: [...session.results],
      totalResults: session.totalMatches,
      runtime: Date.now() - session.startTime
    };
  }

  /**
   * Read search results with offset-based pagination (like read_file)
   * Supports both range reading and tail behavior
   */
  readSearchResults(
    sessionId: string, 
    offset: number = 0, 
    length: number = 100
  ): {
    results: SearchResult[];
    returnedCount: number;        // Renamed from newResultsCount
    totalResults: number;
    totalMatches: number;         // Actual matches (excluding context)
    isComplete: boolean;
    isError: boolean;
    error?: string;
    hasMoreResults: boolean;      // New field
    runtime: number;
    wasIncomplete?: boolean;      // NEW: Indicates if search was incomplete due to permissions
  } {
    const session = this.sessions.get(sessionId);
    
    if (!session) {
      throw new Error(`Search session ${sessionId} not found`);
    }

    // Get all results (excluding internal markers)
    const allResults = session.results.filter(r => r.file !== '__LAST_READ_MARKER__');
    
    // Handle negative offsets (tail behavior) - like file reading
    if (offset < 0) {
      const tailCount = Math.abs(offset);
      const tailResults = allResults.slice(-tailCount);
      return {
        results: tailResults,
        returnedCount: tailResults.length,
        totalResults: session.totalMatches + session.totalContextLines,
        totalMatches: session.totalMatches, // Actual matches only
        isComplete: session.isComplete,
        isError: session.isError && !!session.error?.trim(), // Only error if we have actual errors
        error: session.error?.trim() || undefined,
        hasMoreResults: false, // Tail always returns what's available
        runtime: Date.now() - session.startTime,
        wasIncomplete: session.wasIncomplete
      };
    }

    // Handle positive offsets (range behavior) - like file reading
    const slicedResults = allResults.slice(offset, offset + length);
    const hasMoreResults = offset + length < allResults.length || !session.isComplete;

    session.lastReadTime = Date.now();

    return {
      results: slicedResults,
      returnedCount: slicedResults.length,
      totalResults: session.totalMatches + session.totalContextLines,
      totalMatches: session.totalMatches, // Actual matches only
      isComplete: session.isComplete,
      isError: session.isError && !!session.error?.trim(), // Only error if we have actual errors
      error: session.error?.trim() || undefined,
      hasMoreResults,
      runtime: Date.now() - session.startTime,
      wasIncomplete: session.wasIncomplete
    };
  }

  /**
   * Terminate a search session (like force_terminate)
   */
  terminateSearch(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    
    if (!session) {
      return false;
    }

    if (!session.process.killed) {
      session.process.kill('SIGTERM');
    }

    // Don't delete session immediately - let user read final results
    // It will be cleaned up by cleanup process
    
    return true;
  }

  /**
   * Get list of active search sessions (like list_sessions)
   */
  listSearchSessions(): Array<{
    id: string;
    searchType: string;
    pattern: string;
    isComplete: boolean;
    isError: boolean;
    runtime: number;
    totalResults: number;
  }> {
    return Array.from(this.sessions.values()).map(session => ({
      id: session.id,
      searchType: session.options.searchType,
      pattern: session.options.pattern,
      isComplete: session.isComplete,
      isError: session.isError,
      runtime: Date.now() - session.startTime,
      totalResults: session.totalMatches + session.totalContextLines
    }));
  }

  /**
   * Clean up completed sessions older than specified time
   * Called automatically by cleanup interval
   */
  cleanupSessions(maxAge: number = 5 * 60 * 1000): void {
    const cutoffTime = Date.now() - maxAge;
    
    for (const [sessionId, session] of this.sessions) {
      if (session.isComplete && session.lastReadTime < cutoffTime) {
        this.sessions.delete(sessionId);
      }
    }
  }

  /**
   * Get total number of active sessions (excluding completed ones)
   */
  getActiveSessionCount(): number {
    return Array.from(this.sessions.values()).filter(session => !session.isComplete).length;
  }

  /**
   * Detect if pattern looks like an exact filename
   * (has file extension and no glob wildcards)
   */
  private isExactFilename(pattern: string): boolean {
    return /\.[a-zA-Z0-9]+$/.test(pattern) && 
           !this.isGlobPattern(pattern);
  }

  /**
   * Detect if pattern contains glob wildcards
   */
  private isGlobPattern(pattern: string): boolean {
    return pattern.includes('*') || 
           pattern.includes('?') || 
           pattern.includes('[') || 
           pattern.includes('{') ||
           pattern.includes(']') ||
           pattern.includes('}');
  }

  private buildRipgrepArgs(options: SearchSessionOptions): string[] {
    const args: string[] = [];
    
    if (options.searchType === 'content') {
      // Content search mode
      args.push('--json', '--line-number');
      
      // Add literal search support for content searches
      if (options.literalSearch) {
        args.push('-F'); // Fixed string matching (literal)
      }

      if (options.contextLines && options.contextLines > 0) {
        args.push('-C', options.contextLines.toString());
      }
    } else {
      // File search mode
      args.push('--files');
    }
    
    // Case-insensitive: content searches use -i flag, file searches use --iglob
    if (options.searchType === 'content' && options.ignoreCase !== false) {
      args.push('-i');
    }
    
    if (options.includeHidden) {
      args.push('--hidden');
    }
    
    if (options.maxResults && options.maxResults > 0) {
      args.push('-m', options.maxResults.toString());
    }

    // File pattern filtering (for file type restrictions like *.js, *.d.ts)
    if (options.filePattern) {
      const patterns = options.filePattern
        .split('|')
        .map(p => p.trim())
        .filter(Boolean);
      
      for (const p of patterns) {
        if (options.searchType === 'content') {
          args.push('-g', p);
        } else {
          // For file search: use --iglob for case-insensitive or --glob for case-sensitive
          if (options.ignoreCase !== false) {
            args.push('--iglob', p);
          } else {
            args.push('--glob', p);
          }
        }
      }
    }
    
    // Handle the main search pattern
    if (options.searchType === 'files') {
      // For file search: determine how to treat the pattern
      const globFlag = options.ignoreCase !== false ? '--iglob' : '--glob';
      
      if (this.isExactFilename(options.pattern)) {
        // Exact filename: use appropriate glob flag with the exact pattern
        args.push(globFlag, options.pattern);
      } else if (this.isGlobPattern(options.pattern)) {
        // Already a glob pattern: use appropriate glob flag as-is
        args.push(globFlag, options.pattern);
      } else {
        // Substring/fuzzy search: wrap with wildcards
        args.push(globFlag, `*${options.pattern}*`);
      }
      // Add the root path for file mode
      args.push(options.rootPath);
    } else {
      // Content search: terminate options before the pattern to prevent 
      // patterns starting with '-' being interpreted as flags
      args.push('--', options.pattern, options.rootPath);
    }
    
    return args;
  }

  private setupProcessHandlers(session: SearchSession): void {
    const { process } = session;

    process.stdout?.on('data', (data: Buffer) => {
      session.buffer += data.toString();
      this.processBufferedOutput(session);
    });

    process.stderr?.on('data', (data: Buffer) => {
      const errorText = data.toString();

      // Store error text for potential user display, but don't capture individual errors
      // We'll capture incomplete search status in the completion event instead
      session.error = (session.error || '') + errorText;

      // Filter meaningful errors
      const filteredErrors = errorText
        .split('\n')
        .filter(line => {
          const trimmed = line.trim();

          // Skip empty lines and lines with just symbols/numbers/colons
          if (!trimmed || trimmed.match(/^[\)\(\s\d:]*$/)) return false;

          // Skip all ripgrep system errors that start with "rg:"
          if (trimmed.startsWith('rg:')) return false;

          return true;
        });

      // Only add to session.error if there are actual meaningful errors after filtering
      if (filteredErrors.length > 0) {
        const meaningfulErrors = filteredErrors.join('\n').trim();
        if (meaningfulErrors) {
          session.error = (session.error || '') + meaningfulErrors + '\n';
          capture('search_session_error', {
            sessionId: session.id,
            error: meaningfulErrors.substring(0, 200)
          });
        }
      }
    });

    process.on('close', (code: number) => {
      // Process any remaining buffer content
      if (session.buffer.trim()) {
        this.processBufferedOutput(session, true);
      }

      session.isComplete = true;

      // Track if search was incomplete due to access issues
      // Ripgrep exit code 2 means "some files couldn't be searched"
      if (code === 2) {
        session.wasIncomplete = true;
      }

      // Only treat as error if:
      // 1. Unexpected exit code (not 0, 1, or 2) AND
      // 2. We have meaningful errors after filtering AND
      // 3. We found no results at all
      if (code !== 0 && code !== 1 && code !== 2) {
        // Codes 0=success, 1=no matches, 2=some files couldn't be searched
        if (session.error?.trim() && session.totalMatches === 0) {
          session.isError = true;
          session.error = session.error || `ripgrep exited with code ${code}`;
        }
      }

      // If we have results, don't mark as error even if there were permission issues
      if (session.totalMatches > 0) {
        session.isError = false;
      }

      capture('search_session_completed', {
        sessionId: session.id,
        exitCode: code,
        totalResults: session.totalMatches + session.totalContextLines,
        totalMatches: session.totalMatches,
        runtime: Date.now() - session.startTime,
        wasIncomplete: session.wasIncomplete || false  // NEW: Track incomplete searches
      });

      // Rely on cleanupSessions(maxAge) only; no per-session timer
    });

    process.on('error', (error: Error) => {
      session.isComplete = true;
      session.isError = true;
      session.error = `Process error: ${error.message}`;

      // Rely on cleanupSessions(maxAge) only; no per-session timer
    });
  }

  private processBufferedOutput(session: SearchSession, isFinal: boolean = false): void {
    const lines = session.buffer.split('\n');
    
    // Keep the last incomplete line in the buffer unless this is final processing
    if (!isFinal) {
      session.buffer = lines.pop() || '';
    } else {
      session.buffer = '';
    }
    
    for (const line of lines) {
      if (!line.trim()) continue;
      
      const result = this.parseLine(line, session.options.searchType);
      if (result) {
        session.results.push(result);
        // Separate counting of matches vs context lines
        if (result.type === 'content' && line.includes('"type":"context"')) {
          session.totalContextLines++;
        } else {
          session.totalMatches++;
        }

        // Early termination for exact filename matches (if enabled)
        if (session.options.earlyTermination !== false && // Default to true
            session.options.searchType === 'files' &&
            this.isExactFilename(session.options.pattern)) {
          const pat = path.normalize(session.options.pattern);
          const filePath = path.normalize(result.file);
          const ignoreCase = session.options.ignoreCase !== false;
          const ends = ignoreCase
            ? filePath.toLowerCase().endsWith(pat.toLowerCase())
            : filePath.endsWith(pat);
          if (ends) {
            // Found exact match, terminate search early
            setTimeout(() => {
              if (!session.process.killed) {
                session.process.kill('SIGTERM');
              }
            }, 100); // Small delay to allow any remaining results
            break;
          }
        }
      }
    }
  }

  private parseLine(line: string, searchType: 'files' | 'content'): SearchResult | null {
    if (searchType === 'content') {
      // Parse JSON output from content search
      try {
        const parsed = JSON.parse(line);
        
        if (parsed.type === 'match') {
          // Handle multiple submatches per line - return first submatch
          const submatch = parsed.data?.submatches?.[0];
          return {
            file: parsed.data.path.text,
            line: parsed.data.line_number,
            match: submatch?.match?.text || parsed.data.lines.text,
            type: 'content'
          };
        }
        
        if (parsed.type === 'context') {
          return {
            file: parsed.data.path.text,
            line: parsed.data.line_number,
            match: parsed.data.lines.text.trim(),
            type: 'content'
          };
        }
        
        // Handle summary to reconcile totals
        if (parsed.type === 'summary') {
          // Optional: could reconcile totalMatches with parsed.data.stats?.matchedLines
          return null;
        }
        
        return null;
      } catch (error) {
        // Skip invalid JSON lines
        return null;
      }
    } else {
      // File search - each line is a file path
      return {
        file: line.trim(),
        type: 'file'
      };
    }
  }
}

// Global search manager instance
export const searchManager = new SearchManager();

// Cleanup management - run on fixed schedule
let cleanupInterval: NodeJS.Timeout | null = null;

/**
 * Start cleanup interval - now runs on fixed schedule
 */
function startCleanupIfNeeded(): void {
  if (!cleanupInterval) {
    cleanupInterval = setInterval(() => {
      searchManager.cleanupSessions();
    }, 5 * 60 * 1000);
    
    // Also check immediately after a short delay (let search process finish)
    setTimeout(() => {
      searchManager.cleanupSessions();
    }, 1000);
  }
}