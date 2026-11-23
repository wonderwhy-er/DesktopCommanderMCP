/**
 * An exact-filename FILE search ("find report.json") that finishes within its
 * short default time limit finds its file and reports that it completed, not
 * that it timed out.
 *
 * This races the product's own 1.5 s default (EXACT_FILENAME_SEARCH_TIMEOUT_MS
 * in src/search-manager.ts): ripgrep has to start and walk the folder inside
 * it, which a busy machine (or an antivirus scanning ripgrep as it starts) can
 * make take longer. The limit is the product's, so the test can't give it more
 * room, and it stays on the list of timed tests (test/timed.txt). The other
 * time-limit checks, which hold on a loaded machine, are in test-search-timeout.js.
 */

import assert from 'assert';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { handleStartSearch, handleGetMoreSearchResults, handleStopSearch } from '../dist/handlers/search-handlers.js';
import { searchManager } from '../dist/search-manager.js';
import { configManager } from '../dist/config-manager.js';
import { runIfMain } from './helpers/run-if-main.js';
import { waitUntil } from './helpers/wait.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, 'search-timeout-default-test');

// Looks like an exact filename: the pattern the short default is meant for
const FILENAME = 'report.json';

// The default time limit of an exact-filename file search
const EXACT_FILENAME_TIMEOUT_MS = 1500;

// The search completes at once or at its 1.5 s default; the wait returns then
const COMPLETE_WAIT_MS = 30_000;

/** Current state of a session, as get_more_search_results reports it */
async function readSession(sessionId) {
  const page = await handleGetMoreSearchResults({ sessionId, offset: 0, length: 100 });
  assert(!page.isError, `Reading the session should succeed, got: ${page.content[0].text}`);
  return page.structuredContent;
}

/**
 * An exact-filename file search that finishes within the default finds the
 * file and reports that it completed
 */
async function testFileSearchFinishesWithinFilenameDefault() {
  console.log(`Testing that a file search for "${FILENAME}" that finishes within the ${EXACT_FILENAME_TIMEOUT_MS}ms default reports it completed...`);

  const root = await fs.realpath(TEST_DIR);
  const started = await handleStartSearch({ path: TEST_DIR, pattern: FILENAME, searchType: 'files' });
  assert(!started.isError, `start_search should succeed, got: ${started.content[0].text}`);
  const { sessionId } = started.structuredContent;
  try {
    let state;
    await waitUntil(async () => (state = await readSession(sessionId)).isComplete, COMPLETE_WAIT_MS, 'the file search completes');
    assert.strictEqual(state.outcome, 'completed',
      `A file search that finished within its ${EXACT_FILENAME_TIMEOUT_MS}ms default did not time out, got: ${JSON.stringify(state)}`);
    assert.deepStrictEqual(searchManager.readSearchResults(sessionId).results, [{ file: path.join(root, FILENAME), type: 'file' }],
      'The file search should find exactly the file');

    console.log('✓ File search finished within the exact-filename default and reports outcome completed');
  } finally {
    await handleStopSearch({ sessionId });
  }
}

export default async function runTests() {
  const originalConfig = await configManager.getConfig();
  await fs.rm(TEST_DIR, { recursive: true, force: true });
  await fs.mkdir(TEST_DIR, { recursive: true });
  await fs.writeFile(path.join(TEST_DIR, FILENAME), '{}');
  await fs.writeFile(path.join(TEST_DIR, 'notes.txt'), `see ${FILENAME}\n`);
  await configManager.setValue('allowedDirectories', [TEST_DIR]);
  try {
    await testFileSearchFinishesWithinFilenameDefault();
    console.log('✅ Exact-filename default test passed');
  } finally {
    // Stop any search still running (before its files are removed) and drop all sessions
    searchManager.dispose();
    await configManager.updateConfig(originalConfig);
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  }
}

runIfMain(import.meta.url, runTests);
