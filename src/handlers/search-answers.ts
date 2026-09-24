import type { SearchResult, SearchState, Unsearched, UnsearchedKind } from '../search-manager.js';
import { SHOWN_TEXT_CHARS } from '../search-manager.js';
import type { ServerResult } from '../types.js';

/**
 * The words of the search answers (start_search, get_more_search_results), in
 * one place (#768). Each answer ends saying how the search ended: its outcome
 * (SearchOutcome in search-manager.ts).
 */
export const SEARCH_WORDS = {
  /** "Total results: …", the same in both answers */
  total: (matches: number, rows: number) =>
    `${matches === 1 ? '1 match' : `${matches} matches`}${rows > matches ? ` (${rows} rows with context)` : ''}`,
  matchRow: (file: string, line: number | undefined, text: string) => `📄 ${file}:${line} - ${text}`,
  contextRow: (file: string, line: number | undefined, text: string) => `   ${file}:${line} · ${text}`,
  fileRow: (file: string) => `📁 ${file}`,

  /** A page with no results */
  noMatches: 'No matches found.',
  noneAtOffset: (offset: number, rows: number) => `No results at offset ${offset} (${rows} in total).`,
  noneYet: (offset: number, rows: number) =>
    `Still running: ${rows === 1 ? '1 result' : `${rows} results`} so far${offset >= 0 ? `, none at offset ${offset} yet` : ''}.`,

  /** After a page's results: whether there are more */
  moreResults: (nextOffset: number) => `📖 More results available. Use get_more_search_results with offset: ${nextOffset}`,
  moreMayCome: 'Still running: more may come.',
  inProgress: '🔄 Search in progress. Use get_more_search_results to get more results.',

  /** How the search ended, by outcome */
  completed: '✅ Search completed.',
  timedOut: (ms: number | undefined) => `⏱️ Stopped after ${ms} ms: results may be incomplete.`,
  stopped: '⏹️ Stopped on request: results may be incomplete.',
  maxResults: (n: number | undefined) => `Stopped at maxResults (${n}): there may be more.`,
  /** Partial, when the only files it couldn't search were ones it may not read: as it always said */
  permissionsOnly: '✅ Search completed.\n⚠️  Warning: Some files were inaccessible due to permissions. Results may be incomplete.',
  partial: (reasons: string[]) => `⚠️ Completed, but some files couldn't be searched: ${reasons.join('; ')}.`,
  unsearched: {
    permissions: () => 'some files were inaccessible due to permissions',
    ripgrep_error: (u) => `ripgrep: ${u.example}${andMore(u)}`,
    ripgrep_ended: (u) => `ripgrep stopped unexpectedly (${u.example})`,
    excel_search: (u) => `the Excel search failed (${u.example})`,
    docx_search: (u) => `the DOCX search failed (${u.example})`,
    excel_file: (u) => `${counted(u, 'an Excel file', 'Excel files')} couldn't be read (${u.example}${andMore(u)})`,
    docx_file: (u) => `${counted(u, 'a DOCX file', 'DOCX files')} couldn't be read (${u.example}${andMore(u)})`,
    excel_folder: (u) => `${counted(u, 'a folder', 'folders')} couldn't be listed for the Excel search (${u.example}${andMore(u)})`,
    docx_folder: (u) => `${counted(u, 'a folder', 'folders')} couldn't be listed for the DOCX search (${u.example}${andMore(u)})`,
  } satisfies Record<UnsearchedKind, (u: Unsearched) => string>,

  /** A failed search's whole answer */
  failedWithError: (sessionId: string, error: string) => `Search session ${sessionId} encountered an error: ${error}`,
  failedRipgrepEnded: (sessionId: string, how: string) => `Search session ${sessionId} failed: ripgrep stopped unexpectedly (${how}).`,
};

const andMore = (u: Unsearched) => (u.count > 1 ? ` and ${u.count - 1} more` : '');
const counted = (u: Unsearched, one: string, many: string) => (u.count === 1 ? one : `${u.count} ${many}`);

/** A result as answers list it: a match, a line around one, or a file */
function resultRow(result: SearchResult): string {
  if (result.type !== 'content') return SEARCH_WORDS.fileRow(result.file);
  const text = `${result.match?.substring(0, SHOWN_TEXT_CHARS)}${result.match && result.match.length > SHOWN_TEXT_CHARS ? '...' : ''}`;
  return (result.context ? SEARCH_WORDS.contextRow : SEARCH_WORDS.matchRow)(result.file, result.line, text);
}

/** How a complete search ended, as its answer's last line(s); undefined while it runs */
function endedText(state: SearchState): string | undefined {
  switch (state.outcome) {
    case 'completed': return SEARCH_WORDS.completed;
    case 'timed_out': return SEARCH_WORDS.timedOut(state.timeLimitMs);
    case 'stopped': return SEARCH_WORDS.stopped;
    case 'max_results': return SEARCH_WORDS.maxResults(state.maxResults);
    case 'partial':
      return state.unsearched.every(u => u.kind === 'permissions')
        ? SEARCH_WORDS.permissionsOnly
        : SEARCH_WORDS.partial(state.unsearched.map(u => SEARCH_WORDS.unsearched[u.kind](u)));
    default: return undefined;
  }
}

/** The answer to a search that failed, whichever tool reads it */
function failedAnswer(state: SearchState): ServerResult {
  const failure = state.failure!;
  const text = 'error' in failure
    ? SEARCH_WORDS.failedWithError(state.sessionId, failure.error)
    : SEARCH_WORDS.failedRipgrepEnded(state.sessionId, failure.ripgrepEnded);
  return {
    content: [{ type: 'text', text }],
    isError: true,
    structuredContent: { sessionId: state.sessionId, isComplete: state.isComplete, outcome: state.outcome },
  };
}

/** start_search's answer: the search as it is once it started, with its first results */
export function startSearchAnswer(
  search: SearchState & { results: SearchResult[] },
  args: { searchType: 'files' | 'content'; pattern: string; path: string }
): ServerResult {
  if (search.outcome === 'failed') return failedAnswer(search);

  let text = `Started ${args.searchType === 'content' ? 'content search' : 'file search'} session: ${search.sessionId}\n`;
  text += `Pattern: "${args.pattern}"\n`;
  text += `Path: ${args.path}\n`;
  text += `Status: ${search.isComplete ? 'COMPLETED' : 'RUNNING'}\n`;
  text += `Runtime: ${Math.round(search.runtime)}ms\n`;
  text += `Total results: ${SEARCH_WORDS.total(search.totalMatches, search.totalResults)}\n\n`;

  if (search.results.length > 0) {
    text += 'Initial results:\n';
    for (const result of search.results.slice(0, 10)) {
      text += `${resultRow(result)}\n`;
    }
    if (search.results.length > 10) {
      text += `... and ${search.results.length - 10} more results\n`;
    }
  }

  text += `\n${endedText(search) ?? SEARCH_WORDS.inProgress}`;

  return {
    content: [{ type: 'text', text }],
    structuredContent: {
      sessionId: search.sessionId,
      isComplete: search.isComplete,
      outcome: search.outcome,
      totalResults: search.totalMatches,
    },
  };
}

/** get_more_search_results' answer: one page of a search's results (a negative offset: its last results) */
export function searchResultsAnswer(
  page: SearchState & { results: SearchResult[]; returnedCount: number; hasMoreResults: boolean },
  offset: number
): ServerResult {
  if (page.outcome === 'failed') return failedAnswer(page);

  let text = `Search session: ${page.sessionId}\n`;
  text += `Status: ${page.isComplete ? 'COMPLETED' : 'IN PROGRESS'}\n`;
  text += `Runtime: ${Math.round(page.runtime / 1000)}s\n`;
  text += `Total results: ${SEARCH_WORDS.total(page.totalMatches, page.totalResults)}\n`;
  if (page.returnedCount > 0) {
    text += offset < 0
      ? `Showing last ${page.returnedCount} results\n`
      : `Showing results ${offset}-${offset + page.returnedCount - 1}\n`;
  }
  text += '\n';

  const nextOffset = offset + page.returnedCount;
  if (page.returnedCount === 0) {
    if (!page.isComplete) text += SEARCH_WORDS.noneYet(offset, page.totalResults);
    else text += page.totalResults === 0 ? SEARCH_WORDS.noMatches : SEARCH_WORDS.noneAtOffset(offset, page.totalResults);
  } else {
    text += 'Results:\n';
    for (const result of page.results) {
      text += `${resultRow(result)}\n`;
    }
    if (offset >= 0 && nextOffset < page.totalResults) {
      text += `\n${SEARCH_WORDS.moreResults(nextOffset)}`;
    } else if (!page.isComplete) {
      text += `\n${SEARCH_WORDS.moreMayCome}`;
    }
  }

  const ended = endedText(page);
  if (ended) text += `\n${ended}`;

  return {
    content: [{ type: 'text', text }],
    structuredContent: {
      sessionId: page.sessionId,
      isComplete: page.isComplete,
      outcome: page.outcome,
      totalResults: page.totalResults,
      totalMatches: page.totalMatches,
      returnedCount: page.returnedCount,
      hasMoreResults: page.hasMoreResults,
    },
  };
}
