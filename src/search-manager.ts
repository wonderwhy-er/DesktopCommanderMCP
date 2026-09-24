import { spawn, ChildProcess } from 'child_process';
import { once } from 'events';
import path from 'path';
import fs from 'fs/promises';
import { validatePath } from './tools/filesystem.js';
import { capture } from './utils/capture.js';
import { logger } from './utils/logger.js';
import { getRipgrepPath } from './utils/ripgrep-resolver.js';
import { isExcelFile } from './utils/files/index.js';
import PizZip from 'pizzip';

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
  maxResultsReached?: boolean;  // options.maxResults matches collected; later matches are dropped
  trailingContext?: { file: string; lastLine: number };  // Where the last ripgrep match's trailing context ends
  pendingSources: Set<SearchSource>;  // Sources still producing results; the session completes when none is left
  timeoutTimer?: NodeJS.Timeout;  // Stops the search at its time limit
  timedOut?: boolean;  // The time limit stopped the search before it finished; more matches may exist
  filePatternIncludes?: { root: string; matchers: Array<(relativePath: string) => boolean> };  // A file search's filePattern alternatives but "!" (see filePatternSelects)
  exitCode?: number | null;  // ripgrep's exit code, reported on completion
  printedOutput?: boolean;  // ripgrep wrote to stdout (see the 'close' handler)
  completed: Promise<void>;  // Settles when the session completes
  markCompleted: () => void;
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
 * Default time limit of a file search for an exact filename ("package.json"):
 * a quick lookup of one known file, which gives up rather than walk a huge tree.
 * A content search for the same text looks for every reference to that file,
 * so it has no default limit.
 */
const EXACT_FILENAME_SEARCH_TIMEOUT_MS = 1500;

/** The longest a timer waits (2^31 - 1 ms, ~24.8 days): setTimeout fires a longer delay after 1 ms */
const LONGEST_TIMER_MS = 2 ** 31 - 1;

/** The extensions of the files the Excel and DOCX searches are for (see targetsOfficeFiles) */
const EXCEL_EXTENSIONS = ['.xlsx', '.xls', '.xlsm', '.xlsb'];
const DOCX_EXTENSIONS = ['.docx'];

/** What a session waits for: ripgrep, and the Excel and DOCX searches alongside it */
type SearchSource = 'ripgrep' | 'excel' | 'docx';

/** How an Excel/DOCX search hands over each match as it finds it, and learns it should stop */
interface SourceSink {
  onMatch(result: SearchResult): void;
  isStopped(): boolean;
}

/**
 * One line of ripgrep's --json output: a match or a context line; the begin or
 * end of a file's lines; the summary at the end
 */
type RipgrepLine =
  | { kind: 'match' | 'context'; result: SearchResult }
  | { kind: 'begin' | 'end'; file: string }
  | { kind: 'summary' };

/** The alternatives of a filePattern ("*.js|*.ts") */
const filePatternAlternatives = (filePattern: string | undefined): string[] =>
  (filePattern ?? '').split('|').map(p => p.trim()).filter(Boolean);

/**
 * A glob as ripgrep matches its -g globs (gitignore style), for the files
 * ripgrep doesn't select itself: a file search's files, and the Excel and DOCX
 * files. Without a '/' it is matched against the file's name, with one against
 * its path below the search path ('/'-separated). '*' and '?' stop at '/', "**"
 * as a whole path segment spans folders, "[...]" is a character class ("[!...]"
 * negated) and "{a,b}" a choice.
 */
function ripgrepGlobMatcher(glob: string, ignoreCase: boolean): (relativePath: string) => boolean {
  const byPath = glob.includes('/');  // "/x.ts" too: x.ts in the search path itself
  const regex = new RegExp(`^${globRegexSource(glob.replace(/^\//, ''))}$`, ignoreCase ? 'i' : '');
  return relativePath => regex.test(byPath ? relativePath : relativePath.slice(relativePath.lastIndexOf('/') + 1));
}

/** The regular expression source of a glob (see ripgrepGlobMatcher) */
function globRegexSource(glob: string): string {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    const classEnd = c === '[' ? characterClassEnd(glob, i) : -1;
    const choiceEnd = c === '{' ? glob.indexOf('}', i) : -1;
    if (c === '*' && glob[i + 1] === '*' && (i === 0 || glob[i - 1] === '/') && (i + 2 === glob.length || glob[i + 2] === '/')) {
      // "**" as a whole path segment: any number of folders ("**/": none too)
      source += i + 2 === glob.length ? '.*' : '(?:.*/)?';
      i += i + 2 === glob.length ? 1 : 2;
    } else if (c === '*') {
      source += '[^/]*';
    } else if (c === '?') {
      source += '[^/]';
    } else if (classEnd > 0) {
      let body = glob.slice(i + 1, classEnd);
      const negated = body.startsWith('!') || body.startsWith('^');
      if (negated) body = body.slice(1);
      source += `[${negated ? '^/' : ''}${body.replace(/[\\\]^]/g, '\\$&')}]`;
      i = classEnd;
    } else if (choiceEnd > 0) {
      source += `(?:${glob.slice(i + 1, choiceEnd).split(',').map(globRegexSource).join('|')})`;
      i = choiceEnd;
    } else {
      source += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return source;
}

/** A file's path below the search path, '/'-separated (just its name when it is the search path) */
const pathBelow = (root: string, file: string): string =>
  path.relative(root, file).split(path.sep).join('/') || path.basename(file);

/** A glob that matches `text` itself: each glob character in a class of its own ("[*]", "[[]") */
const literalGlob = (text: string): string => text.replace(/[*?[\]{}]/g, '[$&]');

/** The ']' that closes the character class opening at `start` (one right after "[" or "[!" is part of it), or -1 */
function characterClassEnd(glob: string, start: number): number {
  let i = start + 1;
  if (glob[i] === '!' || glob[i] === '^') i++;
  if (glob[i] === ']') i++;
  return glob.indexOf(']', i);
}

/**
 * Search Session Manager - handles ripgrep processes like terminal sessions
 * Supports both file search and content search with progressive results
 */export class SearchManager {
  private sessions = new Map<string, SearchSession>();
  private sessionCounter = 0;
  private cleanupTimer: NodeJS.Timeout | null = null;

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
    
    // Get ripgrep path with fallback resolution
    let rgPath: string;
    try {
      rgPath = await getRipgrepPath();
    } catch (err) {
      throw new Error(`Failed to locate ripgrep binary: ${err instanceof Error ? err.message : String(err)}`);
    }
    
    // Start ripgrep process. It matches a glob with a '/' ("src/*.ts") against
    // the path below its working directory: that must be the root path. A root
    // that can't be stat'ed (missing...) can't be searched: start_search answers
    // with why, as for any search that can't start.
    const rootIsDirectory = (await fs.stat(validPath)).isDirectory();
    const rgProcess = spawn(rgPath, args, {
      windowsHide: true,  // Prevent visible console windows on Windows
      cwd: rootIsDirectory ? validPath : undefined
    });
    await this.whenStarted(rgProcess);

    // Create session
    let markCompleted!: () => void;
    const completed = new Promise<void>(resolve => { markCompleted = resolve; });
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
      filePatternIncludes: this.filePatternIncludes(options, validPath),
      pendingSources: new Set<SearchSource>(['ripgrep']),
      completed,
      markCompleted
    };

    this.sessions.set(sessionId, session);

    // Set up process event handlers
    this.setupProcessHandlers(session);

    // Start cleanup interval now that we have a session
    this.startCleanupIfNeeded();

    // Set up the time limit, if any: it stops every source still running.
    // For exact filename file searches, use a shorter default timeout
    const timeoutMs = options.timeout ??
      (this.isExactFilenameSearch(options) ? EXACT_FILENAME_SEARCH_TIMEOUT_MS : undefined);
    if (timeoutMs) {
      session.timeoutTimer = setTimeout(() => {
        session.timedOut = true;
        this.stopSources(session);
      }, Math.min(timeoutMs, LONGEST_TIMER_MS));
    }

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
      this.targetsOfficeFiles(EXCEL_EXTENSIONS, options.filePattern, validPath);

    if (shouldSearchExcel) {
      this.startOfficeSource(session, 'excel', sink => this.searchExcelFiles(
        validPath,
        options.pattern,
        options.ignoreCase !== false,
        sink,
        options.filePattern  // Pass filePattern to filter Excel files too
      ));
    }

    // For content searches, also search DOCX files
    const shouldSearchDocx = options.searchType === 'content' &&
      this.targetsOfficeFiles(DOCX_EXTENSIONS, options.filePattern, validPath);

    if (shouldSearchDocx) {
      this.startOfficeSource(session, 'docx', sink => this.searchDocxFiles(
        validPath,
        options.pattern,
        options.ignoreCase !== false,
        sink,
        options.filePattern
      ));
    }

    // Wait for first chunk of data or early completion instead of fixed delay
    // Office searches run in background and add their matches to the session as they find them
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
    maxResultsReached: boolean;   // Search stopped at maxResults matches; more may exist
    timedOut: boolean;            // Search stopped at its time limit before it finished; more may exist
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
        maxResultsReached: !!session.maxResultsReached,
        timedOut: !!session.timedOut
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
      maxResultsReached: !!session.maxResultsReached,
      timedOut: !!session.timedOut
    };
  }

  /**
   * Resolves with all of a session's results once it is complete: every source
   * has finished, or the search was stopped.
   */
  async waitForCompletion(sessionId: string): Promise<SearchResult[]> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new Error(`Search session ${sessionId} not found`);
    }

    await session.completed;
    return [...session.results];
  }

  /**
   * Terminate a search session (like force_terminate)
   */
  terminateSearch(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    
    if (!session) {
      return false;
    }

    this.stopSources(session);

    // Don't delete session immediately - let user read final results
    // It will be cleaned up by cleanup process
    
    return true;
  }

  /**
   * Stop every running search and drop all sessions and the cleanup timer.
   * For owners that tear the search manager down (shutdown, tests); a later
   * startSearch() starts afresh.
   */
  dispose(): void {
    for (const session of this.sessions.values()) {
      this.stopSources(session);
    }
    this.sessions.clear();

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Start the periodic cleanup of old sessions. It is housekeeping only, so it
   * is unref'd: it must never keep the process alive on its own.
   */
  private startCleanupIfNeeded(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanupSessions(), 5 * 60 * 1000);
    this.cleanupTimer.unref();
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
   * Run an Excel or DOCX search as one of the session's sources: its matches are
   * collected as it finds them, until it has searched every file or the session
   * stops it (stop_search, timeout, maxResults).
   */
  private startOfficeSource(
    session: SearchSession,
    source: SearchSource,
    search: (sink: SourceSink) => Promise<void>
  ): void {
    session.pendingSources.add(source);

    const sink: SourceSink = {
      onMatch: result => {
        if (session.pendingSources.has(source)) this.collectMatch(session, result);
      },
      isStopped: () => !session.pendingSources.has(source)
    };

    search(sink)
      .catch((err) => {
        // Log Office search errors but don't fail the whole search
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`The ${source} part of search ${session.id} failed; its matches are missing: ${message}`);
        capture(`${source}_search_error`, { error: message });
      })
      .finally(() => this.finishSource(session, source));
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
    sink: SourceSink,
    filePattern?: string
  ): Promise<void> {
    // Office file search always uses literal matching to prevent ReDoS.
    // Regex patterns are treated as literal strings — this is intentional.
    const searchTerm = ignoreCase ? pattern.toLowerCase() : pattern;

    // Find Excel files recursively
    let excelFiles = await this.findExcelFiles(rootPath, sink.isStopped);

    // Filter by filePattern if provided
    if (filePattern) {
      excelFiles = this.filterOfficeFiles(excelFiles, filePattern, rootPath);
    }

    // Dynamically import ExcelJS to search all sheets
    const ExcelJS = await import('exceljs');

    for (const filePath of excelFiles) {
      if (sink.isStopped()) break;

      try {
        const workbook = new ExcelJS.default.Workbook();
        await workbook.xlsx.readFile(filePath);

        // Search ALL sheets in the workbook (row-wise for speed and cross-column matching)
        for (const worksheet of workbook.worksheets) {
          if (sink.isStopped()) break;

          const sheetName = worksheet.name;

          // Iterate through rows (faster than cell-by-cell)
          worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
            if (sink.isStopped()) return;

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

              sink.onMatch({
                file: `${filePath}:${sheetName}!Row${rowNumber}`,
                line: rowNumber,
                match: matchContext,
                type: 'content'
              });
            }
          });
        }
      } catch (error) {
        // Skip files that can't be read (permission issues, corrupted, etc.)
        continue;
      }
    }
  }

  /**
   * Find all Excel files in a directory recursively. Stops walking once the
   * search is stopped.
   */
  private async findExcelFiles(rootPath: string, isStopped: () => boolean): Promise<string[]> {
    const excelFiles: string[] = [];

    async function walk(dir: string): Promise<void> {
      if (isStopped()) return;
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
   * The Excel/DOCX files a filePattern selects, by the globs ripgrep's text
   * files are selected by (ripgrepGlobMatcher), ignoring case: one of its
   * alternatives matches the file, and none of its "!" alternatives leaves it
   * out (see officeFileExcluded).
   */
  private filterOfficeFiles(files: string[], filePattern: string, rootPath: string): string[] {
    const patterns = filePatternAlternatives(filePattern);
    const includes = patterns.filter(pat => !pat.startsWith('!')).map(pat => ripgrepGlobMatcher(pat, true));
    const excludes = patterns.filter(pat => pat.startsWith('!')).map(pat => pat.slice(1));
    return files.filter(filePath => {
      const relativePath = pathBelow(rootPath, filePath);
      return includes.some(matches => matches(relativePath)) &&
        !excludes.some(pat => this.officeFileExcluded(relativePath, pat));
    });
  }

  /**
   * Whether a "!" alternative of a filePattern (given without its "!") leaves an
   * Excel/DOCX file out - as it leaves text files out of ripgrep's search: when
   * it matches the file, or a directory between the search path and the file;
   * ending in '/', only directories.
   */
  private officeFileExcluded(relativePath: string, exclusion: string): boolean {
    const dirOnly = exclusion.endsWith('/');
    const matches = ripgrepGlobMatcher(exclusion.replace(/\/+$/, ''), true);
    const parts = relativePath.split('/');
    // The directories between the search path and the file, then the file itself
    const candidates = parts.map((_, i) => parts.slice(0, i + 1).join('/')).slice(0, dirOnly ? -1 : undefined);
    return candidates.some(candidate => matches(candidate));
  }

  /**
   * Whether a content search runs the Excel or DOCX search, the one for files
   * with these extensions. Only when contextually relevant: the rootPath is
   * such a file, or a filePattern alternative targets them ("*.xlsx",
   * "budget.xlsx") - which one that leaves files out ("!*.xlsx") does not.
   * Each alternative is checked on its own, so "report.xlsx|memo.docx" runs both.
   */
  private targetsOfficeFiles(extensions: string[], filePattern: string | undefined, rootPath: string): boolean {
    const lowerRootPath = rootPath.toLowerCase();
    const targetingPatterns = filePatternAlternatives(filePattern)
      .filter(pattern => !pattern.startsWith('!'))
      .map(pattern => pattern.toLowerCase());
    return extensions.some(ext => lowerRootPath.endsWith(ext) ||
      targetingPatterns.some(pattern => pattern.includes(`*${ext}`) || pattern.endsWith(ext)));
  }

  /**
   * Search DOCX files for content matches
   * Extracts <w:t> text from document.xml and searches it
   */
  private async searchDocxFiles(
    rootPath: string,
    pattern: string,
    ignoreCase: boolean,
    sink: SourceSink,
    filePattern?: string
  ): Promise<void> {
    // Office file search always uses literal matching to prevent ReDoS.
    // Regex patterns are treated as literal strings — this is intentional.
    const searchTerm = ignoreCase ? pattern.toLowerCase() : pattern;

    let docxFiles = await this.findDocxFiles(rootPath, sink.isStopped);

    if (filePattern) {
      docxFiles = this.filterOfficeFiles(docxFiles, filePattern, rootPath);
    }

    for (const filePath of docxFiles) {
      if (sink.isStopped()) break;

      try {
        const buf = await fs.readFile(filePath);
        const zip = new PizZip(buf);

        // Search all XML parts that can contain text
        const xmlParts = ['word/document.xml', 'word/header1.xml', 'word/header2.xml',
          'word/header3.xml', 'word/footer1.xml', 'word/footer2.xml', 'word/footer3.xml'];

        for (const xmlPath of xmlParts) {
          if (sink.isStopped()) break;

          const file = zip.file(xmlPath);
          if (!file) continue;

          const xml = file.asText();
          // Extract all <w:t> text with position tracking
          const wtRe = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
          let m;
          let lineNum = 0;

          while ((m = wtRe.exec(xml)) !== null) {
            if (sink.isStopped()) break;
            const text = m[1];
            if (!text || !text.trim()) continue;
            lineNum++;

            const textToSearch = ignoreCase ? text.toLowerCase() : text;
            const matchIndex = textToSearch.indexOf(searchTerm);
            if (matchIndex !== -1) {
              const matchContext = this.getMatchContext(text, matchIndex, searchTerm.length);

              const partName = xmlPath === 'word/document.xml' ? '' : `:${xmlPath.replace('word/', '')}`;
              sink.onMatch({
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
  }

  /**
   * Find all DOCX files in a directory recursively. Stops walking once the
   * search is stopped.
   */
  private async findDocxFiles(rootPath: string, isStopped: () => boolean): Promise<string[]> {
    const docxFiles: string[] = [];
    const isDocx = (name: string) => name.toLowerCase().endsWith('.docx');

    async function walk(dir: string): Promise<void> {
      if (isStopped()) return;
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
   * A file search for one exact filename ("package.json"): a lookup of a known
   * file, unlike a content search for that same text
   */
  private isExactFilenameSearch(options: SearchSessionOptions): boolean {
    return options.searchType === 'files' && this.isExactFilename(options.pattern, options.literalSearch);
  }

  /**
   * Detect if pattern looks like an exact filename
   * (has file extension and no glob wildcards; a literal pattern has none)
   */
  private isExactFilename(pattern: string, literal = false): boolean {
    return /\.[a-zA-Z0-9]+$/.test(pattern) &&
           (literal || !this.isGlobPattern(pattern));
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
   * A file search's filePattern alternatives other than "!", which a file it
   * finds must match one of (see filePatternSelects); undefined when there are none
   */
  private filePatternIncludes(options: SearchSessionOptions, root: string): SearchSession['filePatternIncludes'] {
    if (options.searchType !== 'files') return undefined;
    const includes = filePatternAlternatives(options.filePattern).filter(pattern => !pattern.startsWith('!'));
    if (includes.length === 0) return undefined;
    return { root, matchers: includes.map(glob => ripgrepGlobMatcher(glob, options.ignoreCase !== false)) };
  }

  /**
   * Whether a file a file search found is one its filePattern selects: ripgrep
   * checked the "!" alternatives (see buildRipgrepArgs), one of the others must
   * match it. ripgrep can't check those itself: with the pattern's glob in the
   * same list, any glob that matches lets a file in.
   */
  private filePatternSelects(session: SearchSession, file: string): boolean {
    const includes = session.filePatternIncludes;
    if (!includes) return true;
    const relativePath = pathBelow(includes.root, file);
    return includes.matchers.some(matches => matches(relativePath));
  }

  private buildRipgrepArgs(options: SearchSessionOptions): string[] {
    // These arguments are the whole search: the user's ripgrep config file
    // (RIPGREP_CONFIG_PATH) must not add flags such as --hidden, --glob,
    // --max-count or --null that change what is found or the output parsed here
    const args: string[] = ['--no-config'];
    
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
    
    // maxResults is not passed to ripgrep: -m limits matches per file (and lets
    // matches through in trailing context), and --files ignores it. The total cap
    // is enforced on the output instead - see collectMatch().

    // File pattern filtering (for file type restrictions like *.js, *.d.ts)
    if (options.filePattern && options.searchType === 'content') {
      for (const p of filePatternAlternatives(options.filePattern)) {
        args.push('-g', p);
      }
    }

    // Handle the main search pattern
    if (options.searchType === 'files') {
      // For file search: determine how to treat the pattern
      // (--iglob for case-insensitive or --glob for case-sensitive)
      const globFlag = options.ignoreCase !== false ? '--iglob' : '--glob';

      // literalSearch: the pattern is an exact string, glob characters and all
      const name = options.literalSearch ? literalGlob(options.pattern) : options.pattern;
      if (this.isExactFilename(options.pattern, options.literalSearch)) {
        // Exact filename: use appropriate glob flag with the exact pattern
        args.push(globFlag, name);
      } else if (!options.literalSearch && this.isGlobPattern(options.pattern)) {
        // Already a glob pattern: use appropriate glob flag as-is
        args.push(globFlag, options.pattern);
      } else {
        // Substring/fuzzy search: wrap with wildcards
        args.push(globFlag, `*${name}*`);
      }
      // filePattern narrows the files the pattern finds. Its "!" alternatives
      // come after the pattern's glob, since ripgrep's last matching glob wins;
      // the others are checked on what ripgrep finds (filePatternSelects)
      for (const p of filePatternAlternatives(options.filePattern)) {
        if (p.startsWith('!')) args.push(globFlag, p);
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

  /**
   * Resolves once ripgrep has started; else logs why it could not start (not
   * found, not executable...) and rejects with the error start_search always
   * reported. 'spawn' or 'error' comes on the next tick, before any I/O, so
   * the caller still sets up its handlers in time.
   */
  private async whenStarted(child: ChildProcess): Promise<void> {
    try {
      await once(child, 'spawn');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to start ripgrep: ${reason}`);
      throw Object.assign(new Error('Failed to start ripgrep process'), { cause: error });
    }
  }

  private setupProcessHandlers(session: SearchSession): void {
    const { process } = session;

    process.stdout?.on('data', (data: Buffer) => {
      session.printedOutput = true;
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

      // A content search's ripgrep prints a JSON line for each file it searches
      // and a summary at the end: exiting 2 with nothing printed, it could not
      // search at all (an invalid pattern or glob), rather than meeting files it
      // couldn't read. Its error is the answer.
      if (code === 2 && session.options.searchType === 'content' && !session.printedOutput && session.error?.trim()) {
        session.isError = true;
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

      session.exitCode = code;
      this.finishSource(session, 'ripgrep');
    });

    process.on('error', (error: Error) => {
      session.isError = true;
      session.error = `Process error: ${error.message}`;
      this.finishSource(session, 'ripgrep');
    });
  }

  /**
   * A source has ended, or was stopped. This is the one place a session
   * completes: when its last source is done, whatever the order they end in.
   */
  private finishSource(session: SearchSession, source: SearchSource): void {
    session.pendingSources.delete(source);
    if (session.pendingSources.size > 0 || session.isComplete) return;

    // If we have results, don't mark as error even if there were permission issues
    if (session.totalMatches > 0) {
      session.isError = false;
    }

    session.isComplete = true;
    clearTimeout(session.timeoutTimer);

    capture('search_session_completed', {
      sessionId: session.id,
      exitCode: session.exitCode,
      totalResults: session.totalMatches + session.totalContextLines,
      totalMatches: session.totalMatches,
      runtime: Date.now() - session.startTime,
      wasIncomplete: session.wasIncomplete || false,  // NEW: Track incomplete searches
      maxResultsReached: session.maxResultsReached || false,  // Stopped at the cap (exitCode is then null)
      timedOut: session.timedOut || false  // Stopped at the time limit (exitCode is then null)
    });

    session.markCompleted();

    // Rely on cleanupSessions(maxAge) only; no per-session timer
  }

  /**
   * Stop every source still running (stop_search, timeout, dispose); the
   * session completes once ripgrep has exited.
   */
  private stopSources(session: SearchSession): void {
    this.stopOfficeSources(session);
    this.stopRipgrep(session);
  }

  /**
   * The Excel/DOCX searches are done as of now. They can't be interrupted
   * mid-file: each stops at its next check, and anything it still finds is dropped.
   */
  private stopOfficeSources(session: SearchSession): void {
    for (const source of session.pendingSources) {
      if (source === 'excel' || source === 'docx') this.finishSource(session, source);
    }
  }

  private stopRipgrep(session: SearchSession): void {
    if (session.pendingSources.has('ripgrep') && !session.process.killed) {
      session.process.kill('SIGTERM');
    }
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
      
      const parsed = this.parseLine(line, session.options.searchType);
      if (parsed?.kind === 'match' && parsed.result.type === 'file' && !this.filePatternSelects(session, parsed.result.file)) {
        continue;
      }
      if (parsed) {
        this.collectRipgrepLine(session, parsed);

        // Early termination for exact filename matches (if enabled)
        if (parsed.kind === 'match' &&
            session.options.earlyTermination !== false && // Default to true
            this.isExactFilenameSearch(session.options)) {
          const pat = path.normalize(session.options.pattern);
          const filePath = path.normalize(parsed.result.file);
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

  /**
   * Collect one line of ripgrep output. Once maxResults matches are in, only the
   * last match's trailing context is still collected - a matching line inside it
   * is kept as context, like grep -m - and ripgrep is stopped when it ends.
   */
  private collectRipgrepLine(session: SearchSession, line: RipgrepLine): void {
    if (line.kind !== 'match' && line.kind !== 'context') {
      // A file ended (or the next began): no trailing context is pending any more
      session.trailingContext = undefined;
    } else if (!session.maxResultsReached) {
      if (line.kind === 'context') {
        session.results.push(line.result);
        session.totalContextLines++;
      } else {
        // Note where this match's trailing context ends, in case it is the last match
        const contextLines = session.options.contextLines ?? 0;
        session.trailingContext = line.result.type === 'content' && line.result.line !== undefined && contextLines > 0
          ? { file: line.result.file, lastLine: line.result.line + contextLines }
          : undefined;
        this.collectMatch(session, line.result);
      }
    } else {
      const trailing = session.trailingContext;
      const lineNumber = line.result.line;
      if (trailing && line.result.file === trailing.file && lineNumber !== undefined && lineNumber <= trailing.lastLine) {
        session.results.push(line.result);
        session.totalContextLines++;
        if (lineNumber === trailing.lastLine) {
          session.trailingContext = undefined;
        }
      } else {
        // Past the last match's trailing context: everything from here on is dropped
        session.trailingContext = undefined;
      }
    }

    this.stopAtMaxResults(session);
  }

  /**
   * The one place a session counts a match - from ripgrep, Excel or DOCX alike -
   * so maxResults caps the TOTAL number of matches a search returns.
   */
  private collectMatch(session: SearchSession, result: SearchResult): void {
    if (session.maxResultsReached) return;

    session.results.push(result);
    session.totalMatches++;

    const { maxResults } = session.options;
    if (maxResults && maxResults > 0 && session.totalMatches >= maxResults) {
      session.maxResultsReached = true;
      this.stopAtMaxResults(session);
    }
  }

  /**
   * Once maxResults matches are in, stop the sources that cannot contribute
   * anything more: the Excel/DOCX searches at once, ripgrep when the last
   * match's trailing context is complete.
   */
  private stopAtMaxResults(session: SearchSession): void {
    if (!session.maxResultsReached) return;

    this.stopOfficeSources(session);
    if (!session.trailingContext) {
      this.stopRipgrep(session);
    }
  }

  private parseLine(line: string, searchType: 'files' | 'content'): RipgrepLine | null {
    if (searchType === 'content') {
      // Parse JSON output from content search
      try {
        const parsed = JSON.parse(line);
        
        if (parsed.type === 'match') {
          // Handle multiple submatches per line - return first submatch
          const submatch = parsed.data?.submatches?.[0];
          return {
            kind: 'match',
            result: {
              file: parsed.data.path.text,
              line: parsed.data.line_number,
              match: submatch?.match?.text || parsed.data.lines.text,
              type: 'content'
            }
          };
        }
        
        if (parsed.type === 'context') {
          return {
            kind: 'context',
            result: {
              file: parsed.data.path.text,
              line: parsed.data.line_number,
              match: parsed.data.lines.text.trim(),
              type: 'content'
            }
          };
        }
        
        // begin/end frame each file's lines; summary closes the output
        if (parsed.type === 'begin' || parsed.type === 'end') {
          return { kind: parsed.type, file: parsed.data.path.text };
        }
        return { kind: 'summary' };
      } catch (error) {
        // Skip invalid JSON lines
        return null;
      }
    } else {
      // File search - each line is a file path
      return {
        kind: 'match',
        result: {
          file: line.trim(),
          type: 'file'
        }
      };
    }
  }
}

// Global search manager instance
export const searchManager = new SearchManager();
