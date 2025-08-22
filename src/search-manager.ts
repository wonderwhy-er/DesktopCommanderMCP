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
}

/**
 * Search Session Manager - handles ripgrep processes like terminal sessions
 * Supports both file search and content search with progressive results
 */
export class SearchManager {
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
      totalMatches: 0
    };

    this.sessions.set(sessionId, session);

    // Set up process event handlers
    this.setupProcessHandlers(session);

    // Set up timeout if specified and auto-terminate
    if (options.timeout) {
      setTimeout(() => {
        if (!session.isComplete && !session.process.killed) {
          session.process.kill('SIGTERM');
        }
      }, options.timeout);
    }

    capture('search_session_started', {
      sessionId,
      searchType: options.searchType,
      hasTimeout: !!options.timeout
    });

    // Wait a brief moment for initial results or completion
    await new Promise(resolve => setTimeout(resolve, 100));

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
   * Read new results from a search session (like read_process_output)
   * Returns only results found since last read
   */
  readSearchResults(sessionId: string): {
    results: SearchResult[];
    newResultsCount: number;
    totalResults: number;
    isComplete: boolean;
    isError: boolean;
    error?: string;
    runtime: number;
  } {
    const session = this.sessions.get(sessionId);
    
    if (!session) {
      throw new Error(`Search session ${sessionId} not found`);
    }

    // Calculate new results since last read
    const lastReadIndex = session.results.findIndex(r => 
      r.file === '__LAST_READ_MARKER__'
    );
    
    let newResults: SearchResult[];
    if (lastReadIndex === -1) {
      // First read - return all results
      newResults = [...session.results];
    } else {
      // Return results after the marker
      newResults = session.results.slice(lastReadIndex + 1);
      // Remove the old marker
      session.results.splice(lastReadIndex, 1);
    }

    // Add new marker at the end
    if (newResults.length > 0 && !session.isComplete) {
      session.results.push({
        file: '__LAST_READ_MARKER__',
        type: 'file'
      } as SearchResult);
    }

    session.lastReadTime = Date.now();

    return {
      results: newResults,
      newResultsCount: newResults.length,
      totalResults: session.totalMatches,
      isComplete: session.isComplete,
      isError: session.isError,
      error: session.error,
      runtime: Date.now() - session.startTime
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
      capture('search_session_terminated', { sessionId });
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
      totalResults: session.totalMatches
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
        capture('search_session_cleaned_up', { sessionId });
      }
    }
  }

  /**
   * Get total number of active sessions
   */
  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  private buildRipgrepArgs(options: SearchSessionOptions): string[] {
    const args: string[] = [];
    
    if (options.searchType === 'content') {
      // Content search mode
      args.push('--json', '--line-number');
      
      if (options.contextLines && options.contextLines > 0) {
        args.push('-C', options.contextLines.toString());
      }
    } else {
      // File search mode
      args.push('--files');
    }
    
    // Common options
    if (options.ignoreCase !== false) {
      args.push('-i');
    }
    
    if (options.includeHidden) {
      args.push('--hidden');
    }
    
    if (options.maxResults && options.maxResults > 0) {
      args.push('-m', options.maxResults.toString());
    }
    
    // File pattern filtering
    if (options.filePattern) {
      const patterns = options.filePattern
        .split('|')
        .map(p => p.trim())
        .filter(Boolean);
      
      patterns.forEach(pattern => {
        if (options.searchType === 'content') {
          args.push('-g', pattern);
        } else {
          args.push('--glob', pattern);
        }
      });
    }
    
    // Add pattern and path
    if (options.searchType === 'content') {
      args.push(options.pattern);
    }
    args.push(options.rootPath);
    
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
      session.error = (session.error || '') + errorText;
      capture('search_session_error', { 
        sessionId: session.id,
        error: errorText.substring(0, 200) // Limit error length for telemetry
      });
    });

    process.on('close', (code: number) => {
      // Process any remaining buffer content
      if (session.buffer.trim()) {
        this.processBufferedOutput(session, true);
      }
      
      session.isComplete = true;
      
      if (code !== 0 && code !== 1) {
        // ripgrep returns 1 when no matches found, which is not an error
        session.isError = true;
        session.error = session.error || `ripgrep exited with code ${code}`;
      }

      capture('search_session_completed', {
        sessionId: session.id,
        exitCode: code,
        totalResults: session.totalMatches,
        runtime: Date.now() - session.startTime
      });

      // Auto-cleanup completed sessions after 2 minutes
      setTimeout(() => {
        this.sessions.delete(session.id);
        capture('search_session_auto_cleaned', { sessionId: session.id });
      }, 2 * 60 * 1000);
    });

    process.on('error', (error: Error) => {
      session.isComplete = true;
      session.isError = true;
      session.error = `Process error: ${error.message}`;
      
      capture('search_session_process_error', {
        sessionId: session.id,
        error: error.message
      });

      // Auto-cleanup error sessions after 2 minutes
      setTimeout(() => {
        this.sessions.delete(session.id);
        capture('search_session_auto_cleaned', { sessionId: session.id });
      }, 2 * 60 * 1000);
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
        session.totalMatches++;
      }
    }
  }

  private parseLine(line: string, searchType: 'files' | 'content'): SearchResult | null {
    if (searchType === 'content') {
      // Parse JSON output from content search
      try {
        const parsed = JSON.parse(line);
        
        if (parsed.type === 'match') {
          // Return first submatch (ripgrep can have multiple matches per line)
          const submatch = parsed.data.submatches[0];
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

// Automatic cleanup every 5 minutes - make it clearable for tests
let cleanupInterval: NodeJS.Timeout | null = null;

// Only start cleanup interval in production (not during tests)
if (!process.env.NODE_ENV || process.env.NODE_ENV !== 'test') {
  cleanupInterval = setInterval(() => {
    searchManager.cleanupSessions();
  }, 5 * 60 * 1000);
}

// Export cleanup function for graceful shutdown
export function stopSearchManagerCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}
