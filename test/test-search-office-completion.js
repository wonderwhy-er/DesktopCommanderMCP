/**
 * Tests that a content search session reports isComplete only once every
 * source is done - ripgrep AND the Excel/DOCX searches that run alongside it -
 * and that stopping a search (stop_search, timeout, maxResults) stops them all.
 * An Office search that fails is logged, and the search answers as before.
 */

import assert from 'assert';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath, pathToFileURL } from 'url';
import { handleStartSearch, handleGetMoreSearchResults, handleStopSearch } from '../dist/handlers/search-handlers.js';
import { searchManager } from '../dist/search-manager.js';
import { writeFile } from '../dist/tools/filesystem.js';
import { configManager } from '../dist/config-manager.js';
import { startSearchAndWait } from './helpers/search.js';
import { runIfMain } from './helpers/run-if-main.js';
import { runNode } from './helpers/run-node.js';
import { hookArgs } from './helpers/module-hooks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, 'search-office-completion-test');
const DOCX_FILE = path.join(TEST_DIR, 'memo.docx');

// A folder of spreadsheets: the Excel search reads them one by one, so it is
// still running well after ripgrep (which only sees compressed zip bytes) exits
const XLSX_COUNT = 30;
const XLSX_ROWS = 1000;
const xlsxName = (i) => `budget-${String(i).padStart(2, '0')}.xlsx`;

const SEARCH_TEXT = 'ZebraQuartz';
const OFFICE_SEARCH = {
  path: TEST_DIR,
  pattern: SEARCH_TEXT,
  searchType: 'content',
  filePattern: '*.xlsx|*.docx'
};

// How long a full Office search of the fixtures took (set by the first test):
// a stopped session must not change for well past that
let officeSearchMs = 0;

async function setup() {
  const originalConfig = await configManager.getConfig();
  await fs.rm(TEST_DIR, { recursive: true, force: true });
  await fs.mkdir(TEST_DIR, { recursive: true });
  await configManager.setValue('allowedDirectories', [TEST_DIR]);

  // Real Office files, written by Desktop Commander's own Excel and DOCX handlers.
  // Each spreadsheet holds the text once, in its last row.
  const rows = Array.from({ length: XLSX_ROWS - 1 }, (_, i) => [`Item ${i}`, `Note ${i}`]);
  rows.push(['Alice', `${SEARCH_TEXT} budget`]);
  for (let i = 1; i <= XLSX_COUNT; i++) {
    await writeFile(path.join(TEST_DIR, xlsxName(i)), JSON.stringify(rows));
  }
  await writeFile(DOCX_FILE, `Memo title\nThe ${SEARCH_TEXT} review is due`);

  return originalConfig;
}

/** Current state of a session, as get_more_search_results reports it */
async function readSession(sessionId) {
  const page = await handleGetMoreSearchResults({ sessionId, offset: 0, length: 100 });
  assert(!page.isError, `Reading the session should succeed, got: ${page.content[0].text}`);
  return page.structuredContent;
}

/**
 * A completed session is final: nothing may be added to it later. Waits well
 * past the time the Office searches need, then checks nothing changed.
 */
async function assertStaysFinal(sessionId, label) {
  const before = await readSession(sessionId);
  const resultsBefore = searchManager.readSearchResults(sessionId).results;
  assert.strictEqual(before.isComplete, true, `${label}: session should be complete`);

  await new Promise((resolve) => setTimeout(resolve, Math.max(1000, 3 * officeSearchMs)));

  const after = await readSession(sessionId);
  assert.strictEqual(after.totalMatches, before.totalMatches,
    `${label}: a completed session gained matches afterwards (${before.totalMatches} -> ${after.totalMatches})`);
  assert.deepStrictEqual(searchManager.readSearchResults(sessionId).results, resultsBefore,
    `${label}: a completed session's results changed afterwards`);
}

/**
 * Once isComplete is true, the Excel and DOCX matches must be in the results
 */
async function testOfficeResultsPresentWhenComplete() {
  console.log('Testing that Excel/DOCX matches are present once the search is complete...');

  const startedAt = Date.now();
  const sessionId = await startSearchAndWait(OFFICE_SEARCH);
  officeSearchMs = Date.now() - startedAt;

  try {
    const state = await readSession(sessionId);
    assert.strictEqual(state.isComplete, true, 'Session should be complete');
    assert.strictEqual(state.totalMatches, XLSX_COUNT + 1,
      `Once complete, the session should hold every Excel match and the DOCX match, got ${state.totalMatches}`);
    assert.strictEqual(state.maxResultsReached, false, 'No maxResults was set');

    // Search results carry the validated (real) path of the search root
    const root = await fs.realpath(TEST_DIR);
    const expected = [];
    for (let i = 1; i <= XLSX_COUNT; i++) {
      expected.push({
        file: `${path.join(root, xlsxName(i))}:Sheet1!Row${XLSX_ROWS}`,
        line: XLSX_ROWS,
        match: `Alice ${SEARCH_TEXT} budget`,
        type: 'content'
      });
    }
    expected.push({ file: path.join(root, 'memo.docx'), line: 2, match: `The ${SEARCH_TEXT} review is due`, type: 'content' });
    const results = [...searchManager.readSearchResults(sessionId, 0, 1000).results]
      .sort((a, b) => a.file.localeCompare(b.file));
    assert.deepStrictEqual(results, expected,
      'Should hold exactly the Excel rows and the DOCX paragraph that contain the text');

    console.log(`✓ All ${state.totalMatches} Office matches present at completion (${officeSearchMs}ms)`);
  } finally {
    await handleStopSearch({ sessionId });
  }
}

/**
 * maxResults caps matches from all sources together, and the search completes
 * at the cap without waiting for the other Office search
 */
async function testMaxResultsAcrossSources() {
  console.log('Testing maxResults across Excel and DOCX sources...');

  const maxResults = 5;
  const sessionId = await startSearchAndWait({ ...OFFICE_SEARCH, maxResults });
  try {
    const state = await readSession(sessionId);
    assert.strictEqual(state.totalMatches, maxResults,
      `maxResults: ${maxResults} should stop at exactly ${maxResults} matches, got ${state.totalMatches}`);
    assert.strictEqual(state.maxResultsReached, true, 'Session should report that it stopped at maxResults');
    await assertStaysFinal(sessionId, 'maxResults');

    console.log(`✓ ${maxResults} matches across the sources, maxResultsReached reported`);
  } finally {
    await handleStopSearch({ sessionId });
  }
}

/**
 * stop_search stops the Office searches too: the session completes and stays final
 */
async function testStopSearchStopsOfficeSearches() {
  console.log('Testing that stop_search stops the Office searches...');

  const started = await handleStartSearch(OFFICE_SEARCH);
  assert(!started.isError, `start_search should succeed, got: ${started.content[0].text}`);
  const { sessionId } = started.structuredContent;

  const stopped = await handleStopSearch({ sessionId });
  assert(!stopped.isError, `stop_search should succeed, got: ${stopped.content[0].text}`);

  // Stopping does not wait for the Office searches to finish their files
  const deadline = Date.now() + 5000;
  while (!(await readSession(sessionId)).isComplete) {
    assert(Date.now() < deadline, 'A stopped search should complete promptly');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await assertStaysFinal(sessionId, 'stop_search');

  console.log('✓ Stopped session completed and stayed final');
}

/**
 * timeout_ms stops the Office searches too: the session completes and stays final
 */
async function testTimeoutStopsOfficeSearches() {
  console.log('Testing that timeout_ms stops the Office searches...');

  const sessionId = await startSearchAndWait({ ...OFFICE_SEARCH, timeout_ms: 1 }, 5000);
  try {
    await assertStaysFinal(sessionId, 'timeout_ms');
    console.log('✓ Timed-out session completed and stayed final');
  } finally {
    await handleStopSearch({ sessionId });
  }
}

/**
 * An Office search that fails as a whole (here: ExcelJS can't be loaded) must
 * not vanish: the search still answers as before, with the other sources'
 * matches, and the log says which part failed and why. Runs in a child process
 * whose search-manager can't import exceljs.
 */
async function testFailedOfficeSearchIsLogged() {
  console.log('Testing that a failed Office search is logged...');

  const REASON = 'exceljs is unavailable in this test';
  const hooks = `
    export async function resolve(specifier, context, nextResolve) {
      if (specifier === 'exceljs' && context.parentURL?.endsWith('/search-manager.js')) {
        throw new Error(${JSON.stringify(REASON)});
      }
      return nextResolve(specifier, context);
    }`;
  const dist = (file) => pathToFileURL(path.join(__dirname, '..', 'dist', file)).href;
  const script = `
    import { handleGetMoreSearchResults } from ${JSON.stringify(dist('handlers/search-handlers.js'))};
    import { searchManager } from ${JSON.stringify(dist('search-manager.js'))};
    import { startSearchAndWait } from ${JSON.stringify(pathToFileURL(path.join(__dirname, 'helpers', 'search.js')).href)};
    const sessionId = await startSearchAndWait(${JSON.stringify(OFFICE_SEARCH)});
    const page = await handleGetMoreSearchResults({ sessionId });
    searchManager.dispose();
    console.log(JSON.stringify({ sessionId, isError: !!page.isError, text: page.content[0].text }));`;
  const child = await runNode([
    ...hookArgs(`data:text/javascript,${encodeURIComponent(hooks)}`), '--input-type=module', '-e', script,
  ], { timeoutMs: 60000 });
  assert.strictEqual(child.status, 0, `The search process failed (${child.status}): ${child.stderr}`);

  const lines = child.stdout.trim().split('\n');
  const { sessionId, isError, text } = JSON.parse(lines.pop());
  assert.strictEqual(isError, false, `The search should answer as before, got: ${text}`);
  assert(text.includes('memo.docx') && text.includes('✅ Search completed.'),
    `The search should complete with the DOCX match, got: ${text}`);
  // The rest of stdout is what the server logged: JSON-RPC notifications carrying the message in params.data
  const logged = lines.map((line) => JSON.parse(line).params?.data);
  assert.deepStrictEqual(logged, [`The excel part of search ${sessionId} failed; its matches are missing: ${REASON}`],
    'The log should say the Excel search failed, and why');
  console.log('✓ The search answered as before, and the log says why its Excel part failed');
}

export default async function runTests() {
  let originalConfig;
  try {
    originalConfig = await setup();
    await testOfficeResultsPresentWhenComplete();
    await testMaxResultsAcrossSources();
    await testStopSearchStopsOfficeSearches();
    await testTimeoutStopsOfficeSearches();
    await testFailedOfficeSearchIsLogged();
    console.log('✅ Office search completion tests passed');
  } finally {
    // Stop any search still running (before its files are removed) and drop all sessions
    searchManager.dispose();
    if (originalConfig) {
      await configManager.updateConfig(originalConfig);
    }
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  }
}

runIfMain(import.meta.url, runTests);
