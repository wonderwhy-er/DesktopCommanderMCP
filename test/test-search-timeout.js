/**
 * Tests for a search's time limit. An exact-filename FILE search ("find
 * report.json") stops after a short default time limit; a CONTENT search for
 * the same text (references to report.json) must not, or it silently returns
 * partial results. And a search stopped by its time limit must say so
 * (timedOut) instead of looking like a complete search.
 */

import assert from 'assert';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { handleStartSearch, handleGetMoreSearchResults, handleStopSearch } from '../dist/handlers/search-handlers.js';
import { searchManager } from '../dist/search-manager.js';
import { configManager } from '../dist/config-manager.js';
import { createStalledReadTarget } from './helpers/stalled-read.js';
import { runIfMain } from './helpers/run-if-main.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, 'search-timeout-test');
// Same files; searches here never finish on their own (see prepareStall)
const STALLED_DIR = path.join(__dirname, 'search-timeout-stalled');
// Windows: home directory whose git config stalls ripgrep (see prepareStall)
const STALLED_HOME = path.join(__dirname, 'search-timeout-home');

// Looks like an exact filename: the pattern the short default is meant for
const FILENAME = 'report.json';

// The default time limit of an exact-filename file search
const EXACT_FILENAME_TIMEOUT_MS = 1500;

/** Starts a search and returns its start_search structuredContent */
async function startSearch(searchArgs) {
  const started = await handleStartSearch(searchArgs);
  assert(!started.isError, `start_search should succeed, got: ${started.content[0].text}`);
  return started.structuredContent;
}

/**
 * Makes every search in STALLED_DIR block before it lists or searches anything,
 * on a pipe nobody writes to (test/helpers/stalled-read.js). Searches honour
 * ignore files, so ripgrep reads them first:
 * - macOS/Linux: STALLED_DIR/.ignore is a link to the FIFO. ripgrep opens the
 *   ignore files of each directory it walks.
 * - Windows: a named pipe can't live in a directory, and ripgrep there reads
 *   git's global excludes file (core.excludesFile) from the home directory's
 *   git config, even when it isn't a regular file (macOS/Linux skip it). So
 *   STALLED_HOME's git config names the pipe, and stalled searches start with
 *   STALLED_HOME as their home directory (see startStalledSearch).
 */
async function prepareStall(stalledPath) {
  if (process.platform !== 'win32') {
    await fs.symlink(stalledPath, path.join(STALLED_DIR, '.ignore'));
    return;
  }
  await fs.mkdir(STALLED_HOME, { recursive: true });
  // Forward slashes: a backslash starts an escape sequence in a git config value
  // (Windows accepts //./pipe/name for \\.\pipe\name)
  const excludesFile = stalledPath.replaceAll('\\', '/');
  await fs.writeFile(path.join(STALLED_HOME, '.gitconfig'), `[core]\n\texcludesFile = ${excludesFile}\n`);
}

/**
 * Starts a search in STALLED_DIR that never finishes on its own - like one over
 * a huge tree or a stalled network mount - so only a time limit or stop_search
 * ends it (see prepareStall).
 */
async function startStalledSearch(searchArgs) {
  if (process.platform !== 'win32') return startSearch({ path: STALLED_DIR, ...searchArgs });
  // ripgrep on Windows takes the home directory from USERPROFILE (builds before
  // Rust 1.85: HOME). Spawned processes inherit the environment as it is when
  // they start, so it only has to be set until then.
  searchArgs = { path: STALLED_DIR, ...searchArgs };
  const original = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = STALLED_HOME;
  process.env.USERPROFILE = STALLED_HOME;
  try {
    return await startSearch(searchArgs);
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** Current state of a session, as get_more_search_results reports it */
async function readSession(sessionId) {
  const page = await handleGetMoreSearchResults({ sessionId, offset: 0, length: 100 });
  assert(!page.isError, `Reading the session should succeed, got: ${page.content[0].text}`);
  return page.structuredContent;
}

/** Waits until a session reports isComplete and returns its state */
async function waitUntilComplete(sessionId, label) {
  const deadline = Date.now() + 5000;
  let state;
  while (!(state = await readSession(sessionId)).isComplete) {
    assert(Date.now() < deadline, `${label} should complete within 5s`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return state;
}

/**
 * A content search for filename-like text runs until it is done: the
 * exact-filename default must not stop it
 */
async function testContentSearchHasNoFilenameDefault() {
  console.log(`Testing that a content search for "${FILENAME}" is not stopped at ${EXACT_FILENAME_TIMEOUT_MS}ms...`);

  const { sessionId } = await startStalledSearch({ pattern: FILENAME, searchType: 'content' });
  try {
    await new Promise((resolve) => setTimeout(resolve, 2 * EXACT_FILENAME_TIMEOUT_MS));

    const running = await readSession(sessionId);
    assert.strictEqual(running.isComplete, false,
      `A content search must still be running after ${2 * EXACT_FILENAME_TIMEOUT_MS}ms, ` +
      `but it was stopped: ${JSON.stringify(running)}`);

    // Stopped by the caller, not by a time limit
    await handleStopSearch({ sessionId });
    const stopped = await waitUntilComplete(sessionId, 'A stopped search');
    assert.strictEqual(stopped.timedOut, false, 'A search stopped with stop_search did not time out');

    console.log('✓ Content search kept running past the exact-filename default');
  } finally {
    await handleStopSearch({ sessionId });
  }
}

/**
 * An exact-filename file search still stops at the short default, and says it
 * was cut short
 */
async function testFileSearchStopsAtFilenameDefault() {
  console.log(`Testing that a file search for "${FILENAME}" stops at ${EXACT_FILENAME_TIMEOUT_MS}ms and reports it...`);

  const startedAt = Date.now();
  const { sessionId } = await startStalledSearch({ pattern: FILENAME, searchType: 'files' });
  try {
    const state = await waitUntilComplete(sessionId, 'An exact-filename file search');
    const elapsed = Date.now() - startedAt;
    assert(elapsed >= EXACT_FILENAME_TIMEOUT_MS,
      `The file search should run until the ${EXACT_FILENAME_TIMEOUT_MS}ms default, it completed after ${elapsed}ms`);
    assert.deepStrictEqual(
      { isComplete: state.isComplete, timedOut: state.timedOut, totalMatches: state.totalMatches },
      { isComplete: true, timedOut: true, totalMatches: 0 },
      `A file search stopped at the default time limit should report timedOut, got: ${JSON.stringify(state)}`);

    console.log(`✓ File search stopped after ${elapsed}ms with timedOut: true`);
  } finally {
    await handleStopSearch({ sessionId });
  }
}

/**
 * A search stopped by the caller's timeout_ms reports timedOut: it is
 * complete, but did not search everything
 */
async function testTimeoutMsReportsTimedOut() {
  console.log('Testing that a search stopped by timeout_ms reports timedOut...');

  const { sessionId } = await startStalledSearch(
    { pattern: FILENAME, searchType: 'content', timeout_ms: 300 });
  try {
    const state = await waitUntilComplete(sessionId, 'A search with timeout_ms: 300');
    assert.deepStrictEqual(
      { isComplete: state.isComplete, timedOut: state.timedOut, totalMatches: state.totalMatches, maxResultsReached: state.maxResultsReached },
      { isComplete: true, timedOut: true, totalMatches: 0, maxResultsReached: false },
      `A search stopped at timeout_ms should report timedOut, got: ${JSON.stringify(state)}`);

    console.log('✓ Timed-out search reports timedOut: true');
  } finally {
    await handleStopSearch({ sessionId });
  }
}

/**
 * Searches that finish within their time limit find their matches and report
 * timedOut: false
 */
async function testFinishedSearchesDidNotTimeOut() {
  console.log('Testing that searches that finish in time report timedOut: false...');

  const root = await fs.realpath(TEST_DIR);
  const cases = [
    { args: { pattern: FILENAME, searchType: 'files' }, results: [{ file: path.join(root, FILENAME), type: 'file' }] },
    { args: { pattern: FILENAME, searchType: 'content' }, results: [{ file: path.join(root, 'notes.txt'), line: 1, match: FILENAME, type: 'content' }] },
    { args: { pattern: FILENAME, searchType: 'content', timeout_ms: 20000 }, results: [{ file: path.join(root, 'notes.txt'), line: 1, match: FILENAME, type: 'content' }] },
  ];

  for (const { args, results } of cases) {
    const { sessionId } = await startSearch({ path: TEST_DIR, ...args });
    try {
      const state = await waitUntilComplete(sessionId, JSON.stringify(args));
      assert.strictEqual(state.timedOut, false, `${JSON.stringify(args)} finished in time, so it did not time out`);
      assert.deepStrictEqual(searchManager.readSearchResults(sessionId).results, results,
        `${JSON.stringify(args)} should find exactly its match`);
    } finally {
      await handleStopSearch({ sessionId });
    }
  }

  console.log('✓ Finished searches report timedOut: false');
}

export default async function runTests() {
  const originalConfig = await configManager.getConfig();
  for (const dir of [TEST_DIR, STALLED_DIR]) {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, FILENAME), '{}');
    await fs.writeFile(path.join(dir, 'notes.txt'), `see ${FILENAME}\n`);
  }
  await configManager.setValue('allowedDirectories', [TEST_DIR, STALLED_DIR]);
  const stalled = await createStalledReadTarget('dc-search-timeout');
  await fs.rm(STALLED_HOME, { recursive: true, force: true });
  try {
    await prepareStall(stalled.path);
    await testContentSearchHasNoFilenameDefault();
    await testFileSearchStopsAtFilenameDefault();
    await testTimeoutMsReportsTimedOut();
    await testFinishedSearchesDidNotTimeOut();
    console.log('✅ Search time limit tests passed');
  } finally {
    // Stop any search still running (before its files are removed) and drop all sessions
    searchManager.dispose();
    stalled.close();
    await configManager.updateConfig(originalConfig);
    await fs.rm(TEST_DIR, { recursive: true, force: true });
    await fs.rm(STALLED_DIR, { recursive: true, force: true });
    await fs.rm(STALLED_HOME, { recursive: true, force: true });
  }
}

runIfMain(import.meta.url, runTests);
