/**
 * #716: a content search asking for 200 results took the process tree to over
 * 70 GB. Long lines are how a few results get that big: ripgrep's JSON output
 * carries every match and context line whole, whatever --max-columns says.
 * - A session must keep only what its answers show of each line (100
 *   characters), not the whole line: contextLines defaults to 5, so each match
 *   brings up to 10 lines along.
 * - A line too long to process must be skipped, and the answer must say so:
 *   the server assembles each line of ripgrep's output in memory, and past
 *   V8's longest string (2^29 - 24 characters in Node 24) that throws and the
 *   server exits. Only lines over half of that are skipped.
 *   test/repro/test-search-memory.js shows the time and memory behind both.
 */

import assert from 'assert';
import { constants } from 'buffer';
import fs from 'fs';
import path from 'path';
import v8 from 'v8';
import vm from 'vm';
import { handleGetMoreSearchResults, handleStopSearch } from '../dist/handlers/search-handlers.js';
import { searchManager } from '../dist/search-manager.js';
import { configManager } from '../dist/config-manager.js';
import { startSearchAndWait } from './helpers/search.js';
import { connectToServer, readSearchAnswer, closeClient } from './helpers/mcp-client.js';
import { runIfMain } from './helpers/run-if-main.js';
import { createTempDir } from './helpers/test-env.js';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');

const MB = 1024 * 1024;
/** An answer shows this many characters of each result (search-handlers.ts) */
const SHOWN_CHARS = 100;
/**
 * Longer than the longest line of ripgrep output the server assembles: half of
 * V8's longest string (256 MB in Node 24)
 */
const TOO_LONG_LINE_BYTES = Math.floor(constants.MAX_STRING_LENGTH / 2) + MB;
/** Time a search through that line gets: ~2 s when it is skipped, minutes when it is assembled whole */
const SEARCH_LIMIT_MS = 30_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Heap in use after a full garbage collection */
function heapAfterGc() {
  gc();
  return process.memoryUsage().heapUsed;
}

/** Writes `size` bytes of `unit` repeated, to an open file */
function writeRepeated(fd, unit, size) {
  const block = Buffer.from(unit.repeat(Math.ceil(MB / unit.length))).subarray(0, MB);
  for (let left = size; left > 0; left -= block.length) {
    fs.writeSync(fd, block, 0, Math.min(left, block.length));
  }
}

/** Answer text of get_more_search_results for a session */
async function answerOf(sessionId) {
  const page = await handleGetMoreSearchResults({ sessionId, offset: 0, length: 1000 });
  return page.content[0].text;
}

/**
 * Matches between lines of 1 MB, as in minified code: with the default
 * contextLines (5), every result but the matches is a whole 1 MB line.
 */
async function testSessionKeepsWhatAnswersShow(dir) {
  const matches = 5;
  const lineText = 'var a=1;'.repeat(MB / 8);
  const fd = fs.openSync(path.join(dir, 'bundle.min.js'), 'w');
  for (let i = 0; i < matches; i++) {
    fs.writeSync(fd, `needle ${i}\n`);
    for (let c = 0; c < 10; c++) fs.writeSync(fd, `${lineText}\n`);
  }
  fs.closeSync(fd);

  const before = heapAfterGc();
  const sessionId = await startSearchAndWait({ path: dir, pattern: 'needle', searchType: 'content', maxResults: 200 }, 60_000);
  try {
    const kept = heapAfterGc() - before;
    const { totalMatches, totalResults } = searchManager.readSearchResults(sessionId);
    assert.strictEqual(totalMatches, matches, `expected ${matches} matches, got ${totalMatches}`);
    assert(kept < 5 * MB,
      `the session kept ${Math.round(kept / MB)} MB for ${totalMatches} matches and ${totalResults - totalMatches} context lines, ` +
      `though its answers show ${SHOWN_CHARS} characters of each`);

    // What the answer shows stays the same: the first 100 characters of each line, then '...'
    const answer = await answerOf(sessionId);
    assert(answer.includes(`- ${lineText.slice(0, SHOWN_CHARS)}...\n`),
      `the answer should show the first ${SHOWN_CHARS} characters of a context line and '...', got:\n${answer.slice(0, 600)}`);
  } finally {
    await handleStopSearch({ sessionId });
  }
}

/**
 * One matching line longer than the server assembles, then an ordinary match:
 * the search must complete with the ordinary match, and the answer must name
 * the file whose line was skipped. Through the real server in its own process,
 * so a server busy assembling the line cannot hold up this test's time limit;
 * closing the client ends it. The file is the search's root, so ripgrep
 * streams the line instead of holding it.
 */
async function testTooLongLineIsSkipped(dir) {
  const file = path.join(dir, 'huge-line.json');
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, '{"needle":"');
  writeRepeated(fd, 'x', TOO_LONG_LINE_BYTES);
  fs.writeSync(fd, '"}\nan ordinary needle\n');
  fs.closeSync(fd);

  const lineMB = Math.round(TOO_LONG_LINE_BYTES / MB);
  const client = await connectToServer('search-long-lines-test');
  try {
    const deadline = Date.now() + SEARCH_LIMIT_MS;
    const call = (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: Math.max(1, deadline - Date.now()) });
    const started = await call('start_search', { path: file, pattern: 'needle', searchType: 'content', maxResults: 200 });
    const { sessionId } = readSearchAnswer(started);
    assert(sessionId, `start_search failed: ${started.content?.[0]?.text}`);

    let answer;
    try {
      while (answer === undefined) {
        const page = await call('get_more_search_results', { sessionId });
        if (readSearchAnswer(page).isComplete) answer = page.content[0].text;
        else if (Date.now() > deadline) throw new Error('still running');
        else await sleep(100);
      }
    } catch (error) {
      assert.fail(`a search through a line of ${lineMB} MB did not complete within ${SEARCH_LIMIT_MS / 1000} s ` +
        `(${error.message}): the server assembled the line whole instead of skipping it`);
    }
    assert(answer.includes('huge-line.json:2 - needle'), `the ordinary match should be in the answer, got:\n${answer.slice(0, 600)}`);
    const skippedNote = answer.split('\n').find((line) => line.startsWith('Skipped'));
    assert(skippedNote?.includes('huge-line.json') && skippedNote.includes('Searching again gives the same result'),
      `a line of ${lineMB} MB in huge-line.json was processed whole instead of skipped with a note in the answer; the answer was:\n${answer.slice(0, 600)}`);
  } finally {
    await closeClient(client);
  }
}

export default async function runTests() {
  const cases = [
    ['a session keeps only what its answers show of a 1 MB line', testSessionKeepsWhatAnswersShow],
    [`a line over half of V8's longest string is skipped and the answer names its file`, testTooLongLineIsSkipped],
  ];
  const originalConfig = await configManager.getConfig();
  const failures = [];
  try {
    for (const [name, run] of cases) {
      const dir = createTempDir('dc-search-long-lines-');
      try {
        await configManager.setValue('allowedDirectories', [dir]);
        await run(dir);
        console.log(`✓ ${name}`);
      } catch (error) {
        failures.push(name);
        console.log(`✗ ${name}\n  ${error.message}`);
      } finally {
        searchManager.dispose();
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    }
  } finally {
    await configManager.updateConfig(originalConfig);
  }
  if (failures.length > 0) {
    console.log(`❌ ${failures.length} of ${cases.length} long-line cases failed`);
    return false;
  }
  console.log('✅ Long-line search tests passed');
  return true;
}

runIfMain(import.meta.url, runTests);
