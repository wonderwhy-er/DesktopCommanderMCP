import path from 'path';
import { handleStartSearch, handleGetMoreSearchResults, handleStopSearch } from '../../dist/handlers/search-handlers.js';

/**
 * Starts a search and waits until the session reports completion
 * (structuredContent.isComplete). Returns the session id; the caller owns the
 * session and must stop it. Throws if the search can't start, errors, or times out.
 */
export async function startSearchAndWait(searchArgs, timeout = 10000) {
  const started = await handleStartSearch(searchArgs);
  if (started.isError) {
    throw new Error(`start_search failed: ${started.content[0].text}`);
  }
  const { sessionId } = started.structuredContent;

  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const page = await handleGetMoreSearchResults({ sessionId, offset: 0, length: 1 });
    if (page.isError) {
      await handleStopSearch({ sessionId });
      throw new Error(`Search failed: ${page.content[0].text}`);
    }
    if (page.structuredContent.isComplete) return sessionId;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await handleStopSearch({ sessionId });
  throw new Error('Search timed out');
}

/**
 * Runs a search to completion and returns its first page of results
 * (get_more_search_results with the default length). The session is always stopped.
 */
export async function searchAndWaitForCompletion(searchArgs, timeout = 10000) {
  const sessionId = await startSearchAndWait(searchArgs, timeout);
  try {
    const finalResult = await handleGetMoreSearchResults({ sessionId });
    return { finalResult, sessionId };
  } finally {
    await handleStopSearch({ sessionId });
  }
}

/**
 * Runs a search until it ends and returns what the tools answered: start_search's
 * result, and get_more_search_results' first page once the session is complete or
 * the answer is an error (`page` is undefined when start_search itself failed).
 * The session is always stopped.
 */
export async function searchUntilDone(searchArgs, timeout = 10000) {
  const started = await handleStartSearch(searchArgs);
  if (started.isError) return { started };
  const { sessionId } = started.structuredContent;
  try {
    const deadline = Date.now() + timeout;
    for (;;) {
      const page = await handleGetMoreSearchResults({ sessionId, offset: 0, length: 1000 });
      if (page.isError || page.structuredContent.isComplete) return { started, page };
      if (Date.now() > deadline) throw new Error(`The search did not end within ${timeout}ms`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    await handleStopSearch({ sessionId });
  }
}

/** The files an answer lists (📁 file searches, 📄 content searches), relative to `root` with '/' and sorted */
export function filesInAnswer(text, root) {
  return [...new Set(text.split('\n')
    .filter((line) => line.startsWith('📁 ') || line.startsWith('📄 '))
    .map((line) => line.replace(/^(📁|📄) /, '').replace(/:\d+ - .*$/, '').replace(/:[^:\/]+!Row\d+$/, ''))
    .map((file) => path.relative(root, file).split(path.sep).join('/')))].sort();
}
