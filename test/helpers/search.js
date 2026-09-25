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
