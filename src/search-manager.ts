import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { validatePath } from './tools/filesystem.js';
import { capture } from './utils/capture.js';
import { getRipgrepPath } from './utils/ripgrep-resolver.js';
import { isExcelFile } from './utils/files/index.js';
import PizZip from 'pizzip';

/**
 * How much text a session may keep. maxResults bounds the number of entries,
 * never their size, and a context line is stored whole: 400 context lines of a
 * 100KiB file held 78MiB in one session.
 *
 * Counted in characters, not bytes: these are JavaScript string lengths, so a
 * budget of 4M characters is 4MiB of ASCII and up to twice that in memory for
 * text V8 cannot keep in one byte per character.
 *
 * The per-entry cap is well above what a caller is shown — both handlers print
 * at most 100 characters of a result — so it costs nothing visible.
 */
const MAX_RESULT_TEXT_CHARS = 2000;
const MAX_RETAINED_TEXT_CHARS = 4 * 1024 * 1024;

/**
 * How much of a single line the collector may hold before it gives up on it,
 * in characters as above. ripgrep writes one JSON object per line, so a
 * minified bundle can put megabytes on the wire with no newline to break at.
 */
const MAX_BUFFERED_LINE_CHARS = 1024 * 1024;

/**
 * ExcelJS calls its row callback through Array.forEach and ignores what the
 * callback returns, so returning early leaves the row, not the sheet. Throwing
 * this leaves the sheet; it is caught right outside the iteration, where an
 * ordinary error still means a file that cannot be read.
 */
const STOP_SCAN = Symbol('stop-scan');

/**
 * Why an answer holds less than the tree it came from. A session can hit more
 * than one of these, and a new one costs a member here rather than a field in
 * every caller.
 */
export type SearchShortfall = 'max-results' | 'time-limit' | 'output-size';

// Only the first two name a knob, because only they have one: a session that
// ran out of room can be asked for less, but not for more.
const SHORTFALL_SENTENCES: Record<SearchShortfall, string> = {
  'max-results': '⚠️  Stopped at the maxResults limit; there may be more matches. Raise maxResults or narrow the search to see them.',
  'time-limit': '⚠️  Stopped at the time limit; there may be more matches. Raise timeout_ms or narrow the search to see them.',
  'output-size': '⚠️  Output exceeded the size a session keeps; some matches were dropped. Narrow the search to see them.'
};

const SHORTFALL_EVENTS: Record<SearchShortfall, string> = {
  'max-results': 'search_results_truncated',
  'time-limit': 'search_walk_timed_out',
  'output-size': 'search_output_dropped'
};

/** One line per reason, in the order they are listed, with no leading newline. */
export function describeShortfalls(shortfalls: SearchShortfall[] = []): string {
  return shortfalls.map(reason => SHORTFALL_SENTENCES[reason]).join('\n');
}

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
  shortfalls: Set<SearchShortfall>;
  producers: Promise<unknown>[];  // Office searches still running alongside ripgrep
  stopped: boolean;         // The search was cut short; producers check this to give up
  settling: boolean;        // Completion is under way; a second ending must not repeat it
  retainedChars: number;    // Length of the result text held in results[]
  skippingOversizedLine?: boolean;  // Discarding a line too large to buffer
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
    shortfalls: SearchShortfall[];
  }> {
    const sessionId = `search_${++this.sessionCounter}_${Date.now()}`;
    
    // Validate path first
    const validPath = await validatePath(options.rootPath);

    // Build ripgrep arguments
    const args = this.buildRipgrepArgs({ ...options, rootPath: validPath });
    
    // Get ripgrep path with fallback resolution
    let rgPath: string;
    try {
      rgPath = await getRipgrepPath();
    } catch (err) {
      throw new Error(`Failed to locate ripgrep binary: ${err instanceof Error ? err.message : String(err)}`);
    }
    
    // Start ripgrep process
    const rgProcess = spawn(rgPath, args, { windowsHide: true });  // Prevent visible console windows on Windows
    
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
      totalContextLines: 0,
      retainedChars: 0,
      shortfalls: new Set(),
      producers: [],
      stopped: false,
      settling: false
    };

    this.sessions.set(sessionId, session);

    // Set up process event handlers
    this.setupProcessHandlers(session);

    // Start cleanup interval now that we have a session
    startCleanupIfNeeded();

    // A child without a pid never started and will say so on its own 'error'
    // event. The handlers above are already listening, so that event settles the
    // session like any other ending instead of escaping as an unhandled error.
    if (!rgProcess.pid) {
      session.isError = true;
      session.error = 'Failed to start ripgrep process';
      session.stopped = true;
      void this.completeWhenProducersSettle(session, null);
      throw new Error('Failed to start ripgrep process');
    }

    // Set up timeout if specified and auto-terminate
    // For exact filename searches, use a shorter default timeout
    const timeoutMs = options.timeout ?? (this.isExactFilename(options.pattern) ? 1500 : undefined);
    
    let killTimer: NodeJS.Timeout | null = null;
    if (timeoutMs) {
      killTimer = setTimeout(() => {
        if (!session.isComplete) {
          // Filename-shaped patterns get this timeout without asking for it, above
          this.recordShortfall(session, 'time-limit');
          this.killProcess(session);
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

    // For content searches, only search Excel files when contextually relevant:
    // - filePattern explicitly targets Excel files (*.xlsx, *.xls, etc.)
    // - or rootPath is an Excel file itself
    const shouldSearchExcel = options.searchType === 'content' &&
      this.shouldIncludeExcelSearch(options.filePattern, validPath);

    if (shouldSearchExcel) {
      session.producers.push(this.searchExcelFiles(
        validPath,
        options.pattern,
        options.ignoreCase !== false,
        options.maxResults,
        options.filePattern,  // Pass filePattern to filter Excel files too
        options.literalSearch,  // Respect literalSearch flag for Office files
        () => session.stopped
      ).then(excelResults => {
        // Add Excel results to session (merged after initial response).
        // Shares the session budget with ripgrep, so the merge stops once it is spent.
        for (const result of excelResults) {
          if (!this.addResult(session, result, false)) break;
        }
      }).catch((err) => {
        // Log Excel search errors but don't fail the whole search
        capture('excel_search_error', { error: err instanceof Error ? err.message : String(err) });
      }));
    }

    // For content searches, also search DOCX files
    const shouldSearchDocx = options.searchType === 'content' &&
      this.shouldIncludeDocxSearch(options.filePattern, validPath);

    if (shouldSearchDocx) {
      session.producers.push(this.searchDocxFiles(
        validPath,
        options.pattern,
        options.ignoreCase !== false,
        options.maxResults,
        options.filePattern,
        options.literalSearch,  // Respect literalSearch flag for Office files
        () => session.stopped
      ).then(docxResults => {
        for (const result of docxResults) {
          if (!this.addResult(session, result, false)) break;
        }
      }).catch((err) => {
        capture('docx_search_error', { error: err instanceof Error ? err.message : String(err) });
      }));
    }

    // Wait for first chunk of data or early completion instead of fixed delay
    // Excel search runs in background and results are merged via readSearchResults
    const firstChunk = new Promise<void>(resolve => {
      const onData = () => {
        session.process.stdout?.off('data', onData);
        resolve();
      };
      session.process.stdout?.once('data', onData);
      setTimeout(resolve, 40); // cap at 40ms instead of 50-100ms
    });

    // Only wait for ripgrep first chunk - Excel results merge asynchronously
    await firstChunk;

    return {
      sessionId,
      isComplete: session.isComplete,
      isError: session.isError,
      results: [...session.results],
      totalResults: session.totalMatches,
      runtime: Date.now() - session.startTime,
      shortfalls: [...session.shortfalls]
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
    shortfalls: SearchShortfall[];
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
        wasIncomplete: session.wasIncomplete,
        shortfalls: [...session.shortfalls]
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
      wasIncomplete: session.wasIncomplete,
      shortfalls: [...session.shortfalls]
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

    this.killProcess(session);

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
   * Search Excel files for content matches
   * Called during content search to include Excel files alongside text files
   * Searches ALL sheets in each Excel file (row-wise for cross-column matching)
   *
   * TODO: Refactor - Extract Excel search logic to separate module (src/utils/search/excel-search.ts)
   * and inject into SearchManager, similar to how file handlers are structured in src/utils/files/
   * This would allow adding other file type searches (PDF, etc.) without bloating search-manager.ts
   */
  private async searchExcelFiles(
    rootPath: string,
    pattern: string,
    ignoreCase: boolean,
    maxResults?: number,
    filePattern?: string,
    _literalSearch?: boolean,
    stopped: () => boolean = () => false
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];

    // Office file search always uses literal matching to prevent ReDoS.
    // Regex patterns are treated as literal strings — this is intentional.
    const searchTerm = ignoreCase ? pattern.toLowerCase() : pattern;

    // Find Excel files recursively
    let excelFiles = await this.findExcelFiles(rootPath);

    // Filter by filePattern if provided
    if (filePattern) {
      const patterns = filePattern.split('|').map(p => p.trim()).filter(Boolean);
      excelFiles = excelFiles.filter(filePath => {
        const fileName = path.basename(filePath);
        return patterns.some(pat => {
          // Support glob-like patterns
          if (pat.includes('*')) {
            // Escape all regex metacharacters first (preserving * for glob expansion),
            // then convert the remaining * wildcards to .* for glob matching.
            // Without this, patterns like report(2024).xlsx or [draft].xlsx would be
            // misinterpreted as regex groups/character-classes.
            const regexPat = pat
              .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape metacharacters except *
              .replace(/\*/g, '.*');                  // glob * → regex .*
            return new RegExp(`^${regexPat}$`, 'i').test(fileName);
          }
          // Exact match (case-insensitive)
          return fileName.toLowerCase() === pat.toLowerCase();
        });
      });
    }

    // Dynamically import ExcelJS to search all sheets
    const ExcelJS = await import('exceljs');

    for (const filePath of excelFiles) {
      if (stopped()) break;
      if (maxResults && results.length >= maxResults) break;

      try {
        const workbook = new ExcelJS.default.Workbook();
        await workbook.xlsx.readFile(filePath);

        // Search ALL sheets in the workbook (row-wise for speed and cross-column matching)
        for (const worksheet of workbook.worksheets) {
          if (stopped()) break;
          if (maxResults && results.length >= maxResults) break;

          const sheetName = worksheet.name;

          try {
            // Iterate through rows (faster than cell-by-cell)
            worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
              if (stopped()) throw STOP_SCAN;
              if (maxResults && results.length >= maxResults) throw STOP_SCAN;

              // Build a concatenated string of all cell values in the row
              const rowValues: string[] = [];
              row.eachCell({ includeEmpty: false }, (cell) => {
                if (cell.value === null || cell.value === undefined) return;

                let cellStr: string;
                if (typeof cell.value === 'object') {
                  if ('result' in cell.value) {
                    cellStr = String(cell.value.result ?? '');
                  } else if ('richText' in cell.value) {
                    cellStr = (cell.value as any).richText.map((rt: any) => rt.text).join('');
                  } else if ('text' in cell.value) {
                    cellStr = String((cell.value as any).text);
                  } else {
                    cellStr = String(cell.value);
                  }
                } else {
                  cellStr = String(cell.value);
                }

                if (cellStr.trim()) {
                  rowValues.push(cellStr);
                }
              });

              // Join all cell values with space for cross-column matching
              const rowText = rowValues.join(' ');

              const textToSearch = ignoreCase ? rowText.toLowerCase() : rowText;
              const matchIndex = textToSearch.indexOf(searchTerm);
              if (matchIndex !== -1) {
                const matchContext = this.getMatchContext(rowText, matchIndex, searchTerm.length);

                results.push({
                  file: `${filePath}:${sheetName}!Row${rowNumber}`,
                  line: rowNumber,
                  match: matchContext,
                  type: 'content'
                });
              }
            });
          } catch (thrown) {
            if (thrown !== STOP_SCAN) throw thrown;
            break;
          }
        }
      } catch (error) {
        // Skip files that can't be read (permission issues, corrupted, etc.)
        continue;
      }
    }

    return results;
  }

  /**
   * Find all Excel files in a directory recursively
   */
  private async findExcelFiles(rootPath: string): Promise<string[]> {
    const excelFiles: string[] = [];

    async function walk(dir: string): Promise<void> {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            // Skip node_modules, .git, etc.
            if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
              await walk(fullPath);
            }
          } else if (entry.isFile() && isExcelFile(entry.name)) {
            excelFiles.push(fullPath);
          }
        }
      } catch {
        // Skip directories we can't read
      }
    }

    // Check if rootPath is a file or directory
    try {
      const stats = await fs.stat(rootPath);
      if (stats.isFile() && isExcelFile(rootPath)) {
        return [rootPath];
      } else if (stats.isDirectory()) {
        await walk(rootPath);
      }
    } catch {
      // Path doesn't exist or can't be accessed
    }

    return excelFiles;
  }

  /**
   * Determine if DOCX search should be included based on context
   */
  private shouldIncludeDocxSearch(filePattern?: string, rootPath?: string): boolean {
    const docxExtensions = ['.docx'];

    if (rootPath) {
      const lowerPath = rootPath.toLowerCase();
      if (docxExtensions.some(ext => lowerPath.endsWith(ext))) {
        return true;
      }
    }

    if (filePattern) {
      const lowerPattern = filePattern.toLowerCase();
      if (docxExtensions.some(ext =>
        lowerPattern.includes(`*${ext}`) || lowerPattern.endsWith(ext)
      )) {
        return true;
      }
    }

    return false;
  }

  /**
   * Search DOCX files for content matches
   * Extracts <w:t> text from document.xml and searches it
   */
  private async searchDocxFiles(
    rootPath: string,
    pattern: string,
    ignoreCase: boolean,
    maxResults?: number,
    filePattern?: string,
    _literalSearch?: boolean,
    stopped: () => boolean = () => false
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];

    // Office file search always uses literal matching to prevent ReDoS.
    // Regex patterns are treated as literal strings — this is intentional.
    const searchTerm = ignoreCase ? pattern.toLowerCase() : pattern;

    let docxFiles = await this.findDocxFiles(rootPath);

    if (filePattern) {
      const patterns = filePattern.split('|').map(p => p.trim()).filter(Boolean);
      docxFiles = docxFiles.filter(filePath => {
        const fileName = path.basename(filePath);
        return patterns.some(pat => {
          if (pat.includes('*')) {
            const regexPat = pat
              .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape metacharacters except *
              .replace(/\*/g, '.*');                  // glob * → regex .*
            return new RegExp(`^${regexPat}$`, 'i').test(fileName);
          }
          return fileName.toLowerCase() === pat.toLowerCase();
        });
      });
    }

    for (const filePath of docxFiles) {
      if (stopped()) break;
      if (maxResults && results.length >= maxResults) break;

      try {
        const buf = await fs.readFile(filePath);
        const zip = new PizZip(buf);

        // Search all XML parts that can contain text
        const xmlParts = ['word/document.xml', 'word/header1.xml', 'word/header2.xml',
          'word/header3.xml', 'word/footer1.xml', 'word/footer2.xml', 'word/footer3.xml'];

        for (const xmlPath of xmlParts) {
          if (stopped()) break;
          if (maxResults && results.length >= maxResults) break;

          const file = zip.file(xmlPath);
          if (!file) continue;

          const xml = file.asText();
          // Extract all <w:t> text with position tracking
          const wtRe = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
          let m;
          let lineNum = 0;

          while ((m = wtRe.exec(xml)) !== null) {
            if (stopped()) break;
            if (maxResults && results.length >= maxResults) break;
            const text = m[1];
            if (!text || !text.trim()) continue;
            lineNum++;

            const textToSearch = ignoreCase ? text.toLowerCase() : text;
            const matchIndex = textToSearch.indexOf(searchTerm);
            if (matchIndex !== -1) {
              const matchContext = this.getMatchContext(text, matchIndex, searchTerm.length);

              const partName = xmlPath === 'word/document.xml' ? '' : `:${xmlPath.replace('word/', '')}`;
              results.push({
                file: `${filePath}${partName}`,
                line: lineNum,
                match: matchContext,
                type: 'content'
              });
            }
          }
        }
      } catch {
        continue;
      }
    }

    return results;
  }

  /**
   * Find all DOCX files in a directory recursively
   */
  private async findDocxFiles(rootPath: string): Promise<string[]> {
    const docxFiles: string[] = [];
    const isDocx = (name: string) => name.toLowerCase().endsWith('.docx');

    async function walk(dir: string): Promise<void> {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
              await walk(fullPath);
            }
          } else if (entry.isFile() && isDocx(entry.name)) {
            docxFiles.push(fullPath);
          }
        }
      } catch { /* skip */ }
    }

    try {
      const stats = await fs.stat(rootPath);
      if (stats.isFile() && isDocx(rootPath)) {
        return [rootPath];
      } else if (stats.isDirectory()) {
        await walk(rootPath);
      }
    } catch { /* skip */ }

    return docxFiles;
  }

  /**
   * Extract context around a match for display (show surrounding text)
   */
  private getMatchContext(text: string, matchStart: number, matchLength: number): string {
    const contextChars = 50; // chars before and after match
    const start = Math.max(0, matchStart - contextChars);
    const end = Math.min(text.length, matchStart + matchLength + contextChars);

    let context = text.substring(start, end);

    // Add ellipsis if truncated
    if (start > 0) context = '...' + context;
    if (end < text.length) context = context + '...';

    return context;
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

  /**
   * Determine if Excel search should be included based on context
   * Only searches Excel files when:
   * - filePattern explicitly targets Excel files (*.xlsx, *.xls, *.xlsm, *.xlsb)
   * - or the rootPath itself is an Excel file
   */
  private shouldIncludeExcelSearch(filePattern?: string, rootPath?: string): boolean {
    const excelExtensions = ['.xlsx', '.xls', '.xlsm', '.xlsb'];

    // Check if rootPath is an Excel file
    if (rootPath) {
      const lowerPath = rootPath.toLowerCase();
      if (excelExtensions.some(ext => lowerPath.endsWith(ext))) {
        return true;
      }
    }

    // Check if filePattern targets Excel files
    if (filePattern) {
      const lowerPattern = filePattern.toLowerCase();
      // Check for patterns like *.xlsx, *.xls, or explicit Excel extensions
      if (excelExtensions.some(ext =>
        lowerPattern.includes(`*${ext}`) ||
        lowerPattern.endsWith(ext)
      )) {
        return true;
      }
    }

    return false;
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
    
    // maxResults is deliberately not passed to ripgrep: -m caps matching lines
    // per file, not per search, and in --files mode it does nothing at all.
    // addResult() owns the limit and stops the process once it is reached.

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

      // Track if search was incomplete due to access issues
      // Ripgrep exit code 2 means "some files couldn't be searched"
      if (code === 2) {
        session.wasIncomplete = true;
      }

      void this.completeWhenProducersSettle(session, code);
    });

    process.on('error', (error: Error) => {
      session.isError = true;
      session.error = `Process error: ${error.message}`;

      // A failed spawn is a stop like any other: the producers should hear it,
      // and the session is only done once they have.
      session.stopped = true;
      void this.completeWhenProducersSettle(session, null);
    });
  }

  /**
   * ripgrep closing is only half of an answer: the Office producers merge their
   * results, and their reasons, after it. A session that called itself complete
   * here would be handing out an answer it is still writing, and the completion
   * event would go out without whatever they found.
   */
  private async completeWhenProducersSettle(session: SearchSession, code: number | null): Promise<void> {
    // A failed spawn emits 'error' and then 'close', and a kill can do the same:
    // the session ends once, and says so once.
    if (session.settling) {
      return;
    }
    session.settling = true;

    if (session.producers.length > 0) {
      await Promise.allSettled(session.producers);
    }

    session.isComplete = true;

    {
      // Only treat as error if:
      // 1. Unexpected exit code (not 0, 1, or 2) AND
      // 2. We have meaningful errors after filtering AND
      // 3. We found no results at all
      if (code !== null && code !== 0 && code !== 1 && code !== 2) {
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
        wasIncomplete: session.wasIncomplete || false,  // NEW: Track incomplete searches
        shortfalls: [...session.shortfalls].join(',')
      });
    }

    // Rely on cleanupSessions(maxAge) only; no per-session timer
  }

  /**
   * Stopping a search is not only ripgrep's business: the Office producers read
   * on their own, and nothing else tells them the answer is no longer wanted.
   */
  private killProcess(session: SearchSession): void {
    session.stopped = true;
    if (!session.process.killed) {
      session.process.kill('SIGTERM');
    }
  }

  /**
   * The one writer of session.shortfalls, and the one place each degraded
   * outcome is reported — once per session, however many times it is hit.
   */
  private recordShortfall(session: SearchSession, reason: SearchShortfall): void {
    if (session.shortfalls.has(reason)) {
      return;
    }

    session.shortfalls.add(reason);
    capture(SHORTFALL_EVENTS[reason], {
      sessionId: session.id,
      searchType: session.options.searchType,
      matches: session.totalMatches,
      retainedChars: session.retainedChars,
      runtime: Date.now() - session.startTime
    });
  }

  /**
   * Has this session collected everything maxResults allows?
   * maxResults of 0 or undefined means no limit.
   */
  private isBudgetExhausted(session: SearchSession): boolean {
    const limit = session.options.maxResults;
    return !!limit && limit > 0 && session.totalMatches >= limit;
  }

  /**
   * The one place a result enters a session. Every producer (ripgrep, Excel,
   * DOCX) goes through here, so maxResults is counted once, for the whole
   * search, instead of once per producer or once per file.
   *
   * Context lines are stored but not charged to the budget: they belong to a
   * match that was already accepted rather than being results of their own, and
   * they never stop collection. They stay bounded by the matches that carry
   * them: ripgrep only reports context around a match.
   *
   * Collection runs until a match has to be turned away — that match, not the
   * budget going to zero, is what proves something was left behind. A tree
   * holding exactly maxResults matches therefore finishes whole and unmarked,
   * while a larger one is stopped by its next match and says so: a budget-sized
   * answer out of a much larger tree otherwise looks exactly like a search that
   * found that much.
   *
   * The same door holds the text budget: an entry's text is capped, and once the
   * session has kept MAX_RETAINED_TEXT_CHARS it stops taking anything at all.
   *
   * Returns false when a result was turned away and the caller must stop.
   */
  private addResult(session: SearchSession, result: SearchResult, isContext: boolean): boolean {
    if (!isContext && this.isBudgetExhausted(session)) {
      this.recordShortfall(session, 'max-results');
      return false;
    }

    if (result.match && result.match.length > MAX_RESULT_TEXT_CHARS) {
      // Not worth reporting: both handlers print at most 100 characters of a
      // result, so the caller cannot tell the difference.
      result.match = `${result.match.slice(0, MAX_RESULT_TEXT_CHARS - 1)}…`;
    }

    // What the entry costs after the cap is what decides whether it fits: a
    // budget checked before the cost is one the next entry walks past.
    const entryChars = (result.match?.length || 0) + result.file.length;
    if (session.retainedChars + entryChars > MAX_RETAINED_TEXT_CHARS) {
      // Not even context, which would otherwise ride along free
      this.recordShortfall(session, 'output-size');
      return false;
    }
    session.retainedChars += entryChars;

    session.results.push(result);
    if (isContext) {
      session.totalContextLines++;
    } else {
      session.totalMatches++;
    }

    return true;
  }

  private processBufferedOutput(session: SearchSession, isFinal: boolean = false): void {
    if (session.skippingOversizedLine) {
      // Mid-line, with no way to parse what has already been thrown away: drop
      // everything up to the newline that ends it, then carry on.
      const end = session.buffer.indexOf('\n');
      if (end === -1) {
        session.buffer = '';
        return;
      }
      session.buffer = session.buffer.slice(end + 1);
      session.skippingOversizedLine = false;
    }

    const lines = session.buffer.split('\n');

    // Keep the last incomplete line in the buffer unless this is final processing
    if (!isFinal) {
      session.buffer = lines.pop() || '';
    } else {
      session.buffer = '';
    }

    if (session.buffer.length > MAX_BUFFERED_LINE_CHARS) {
      // One line, already larger than anything worth holding, and still no
      // newline: give up on it rather than grow with it. The match it carried
      // is lost, which is what the caller is told.
      session.skippingOversizedLine = true;
      this.recordShortfall(session, 'output-size');
      session.buffer = '';
    }

    for (const line of lines) {
      if (!line.trim()) continue;
      
      const result = this.parseLine(line, session.options.searchType);
      if (result) {
        const isContext = result.type === 'content' && line.includes('"type":"context"');
        if (!this.addResult(session, result, isContext)) {
          // A match past maxResults: drop what is still buffered and stop ripgrep
          session.buffer = '';
          this.killProcess(session);
          return;
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
            setTimeout(() => this.killProcess(session), 100); // Small delay to allow any remaining results
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