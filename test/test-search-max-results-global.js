/**
 * maxResults must cap the whole search, not each file (GitHub issue #716).
 * Counts are exact: a cap that fires one result early fails too.
 * HOME/USERPROFILE move first, so no run touches the real config file.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

const MAX_RESULTS = 5;
const FILE_COUNT = 20;
const MATCHES_PER_FILE = 10;
const NEEDLE = 'GLOBAL_LIMIT_NEEDLE';
const SMALL_MATCHES = 3;
const SLOW_FILES = 1200;
const SLOW_LINES = 40;
const COMPLETION_TIMEOUT_MS = 20000;
// Fewer than MAX_RESULTS across both text files, so the Excel producer has to
// contribute for the budget to be reached at all.
const TEXT_MATCHES_PER_OFFICE_FILE = 2;
// One more needle in the workbook than the budget allows, so the Excel producer
// alone has to turn a match away.
const OFFICE_MATCHES = MAX_RESULTS + 1;

const tempDirs = [];

const cutShortBy = (state, reason) => (state.shortfalls || []).includes(reason);

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeTempHome() {
  const home = makeTempDir('dc716-home-');
  const configDir = path.join(home, '.claude-server-commander');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    telemetryEnabled: false,
    allowedDirectories: [],
    welcomeOnboardingEligible: false,
    pendingWelcomeOnboarding: false
  }));
  return home;
}

/** More matches than any cap under test, so a per-file cap shows up as a larger total. */
function makeFixture() {
  const dir = makeTempDir('dc716-files-');
  const body = Array.from({ length: MATCHES_PER_FILE }, (_, line) => `line ${line} ${NEEDLE}`).join('\n');
  for (let i = 0; i < FILE_COUNT; i++) {
    fs.writeFileSync(path.join(dir, `file${i}.txt`), `${body}\n`);
  }
  return dir;
}

/** Fewer needles than the budget will allow, so the search ends on its own. */
function makeSmallFixture() {
  const dir = makeTempDir('dc716-small-');
  const body = Array.from({ length: SMALL_MATCHES }, (_, line) => `line ${line} ${NEEDLE}`).join('\n');
  fs.writeFileSync(path.join(dir, 'small.txt'), `${body}\n`);
  return dir;
}

/** Half a second of walking: with a smaller tree the timeout has nothing left to cut. */
function makeSlowFixture() {
  const dir = makeTempDir('dc716-slow-');
  const body = Array.from({ length: SLOW_LINES }, (_, line) => `line ${line} ${NEEDLE}`).join('\n');
  for (let i = 0; i < SLOW_FILES; i++) {
    fs.writeFileSync(path.join(dir, `file${i}.txt`), `${body}\n`);
  }
  return dir;
}

/** Needles separated by filler, so ripgrep has something to report as context. */
function makeSpacedFixture() {
  const dir = makeTempDir('dc716-spaced-');
  const lines = [];
  for (let i = 0; i < 4; i++) {
    lines.push('filler', 'filler', `hit ${i} ${NEEDLE}`, 'filler');
  }
  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(path.join(dir, `spaced${i}.txt`), `${lines.join('\n')}\n`);
  }
  return dir;
}

/**
 * The budget fills only if both producers land, so the case fails whether Excel
 * adds on top of it or adds nothing at all.
 */
async function makeOfficeFixture() {
  const dir = makeTempDir('dc716-office-');
  const body = Array.from({ length: TEXT_MATCHES_PER_OFFICE_FILE }, (_, line) => `line ${line} ${NEEDLE}`).join('\n');
  for (let i = 0; i < 2; i++) {
    fs.writeFileSync(path.join(dir, `text${i}.txt`), `${body}\n`);
  }

  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.default.Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  for (let i = 0; i < OFFICE_MATCHES; i++) {
    sheet.addRow([`row ${i} ${NEEDLE}`]);
  }
  await workbook.xlsx.writeFile(path.join(dir, 'book.xlsx'));
  return dir;
}

function removeQuietly(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Temp directory; the config watcher can still hold it on Windows.
  }
}

/**
 * `until` waits for the Office merge, which lands after the session reads as
 * complete. A fixed delay would let a slow machine pass by default; this makes
 * it wait, and if the predicate never holds the assertions judge what came back.
 */
async function runToCompletion(searchManager, options, until = null) {
  const { sessionId } = await searchManager.startSearch(options);
  const deadline = Date.now() + COMPLETION_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      const state = searchManager.readSearchResults(sessionId, 0, 100000);
      if (state.isComplete) {
        if (!until) return { sessionId, state };

        while (Date.now() < deadline) {
          const merged = searchManager.readSearchResults(sessionId, 0, 100000);
          if (until(merged)) return { sessionId, state: merged };
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        return { sessionId, state: searchManager.readSearchResults(sessionId, 0, 100000) };
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`search did not complete within ${COMPLETION_TIMEOUT_MS}ms`);
  } finally {
    searchManager.terminateSearch(sessionId);
  }
}

async function testContentSearchCapsWholeSearch(searchManager, fixtureDir) {
  // contextLines: 0 keeps context out of it, so "results" and "matches" are one number.
  const { state } = await runToCompletion(searchManager, {
    rootPath: fixtureDir,
    pattern: NEEDLE,
    searchType: 'content',
    contextLines: 0,
    maxResults: MAX_RESULTS
  });

  const available = FILE_COUNT * MATCHES_PER_FILE;
  assert.strictEqual(state.totalMatches, MAX_RESULTS,
    `asked for ${MAX_RESULTS} of ${available} matches, got ${state.totalMatches}`);
  assert.strictEqual(state.results.length, MAX_RESULTS,
    `session kept ${state.results.length} results for maxResults ${MAX_RESULTS}`);
  // Recorded on the branch that also stops ripgrep, so this is the public
  // evidence that collection ended at the budget instead of running on.
  assert.strictEqual(cutShortBy(state, 'max-results'), true,
    'collection must stop at the budget rather than walk the rest of the tree');
  console.log(`✓ content search: exactly ${state.totalMatches} of ${available} matches, stopped at the budget`);
}

async function testFileSearchCapsWholeSearch(searchManager, fixtureDir) {
  const { state } = await runToCompletion(searchManager, {
    rootPath: fixtureDir,
    pattern: '*.txt',
    searchType: 'files',
    maxResults: MAX_RESULTS
  });

  assert.strictEqual(state.results.length, MAX_RESULTS,
    `asked for ${MAX_RESULTS} of ${FILE_COUNT} files, got ${state.results.length}`);
  console.log(`✓ file search: exactly ${state.results.length} of ${FILE_COUNT} files`);
}

async function testContextLinesAreNotCharged(searchManager, spacedDir) {
  const wanted = 3;
  const contextLines = 2;
  const { state } = await runToCompletion(searchManager, {
    rootPath: spacedDir,
    pattern: NEEDLE,
    searchType: 'content',
    contextLines,
    maxResults: wanted
  });

  assert.strictEqual(state.totalMatches, wanted,
    `context lines must not eat the budget: got ${state.totalMatches} matches for maxResults ${wanted}`);
  assert.ok(state.results.length > wanted,
    'expected context lines alongside the matches');
  // Context around the kept matches, plus the context ripgrep had already sent
  // for the match that was turned away
  const bound = wanted * (2 * contextLines + 1) + 2 * contextLines;
  assert.ok(state.results.length <= bound,
    `context is bounded by the matches carrying it: ${state.results.length} entries for ${wanted} matches, bound ${bound}`);
  console.log(`✓ context lines: ${state.totalMatches} matches, ${state.results.length} entries kept`);
}

async function testSearchWithoutLimitIsNotCut(searchManager, fixtureDir) {
  const { state } = await runToCompletion(searchManager, {
    rootPath: fixtureDir,
    pattern: NEEDLE,
    searchType: 'content',
    contextLines: 0
  });

  assert.strictEqual(state.totalMatches, FILE_COUNT * MATCHES_PER_FILE,
    `a search without maxResults must return everything, got ${state.totalMatches}`);
  assert.ok(!cutShortBy(state, 'max-results'),
    'nothing to enforce without maxResults, so the search must run to its own end');
  console.log(`✓ no maxResults: all ${state.totalMatches} matches, nothing cut`);
}

async function testTruncatedSearchSaysSo(searchManager, handleGetMoreSearchResults, fixtureDir) {
  const { sessionId, state } = await runToCompletion(searchManager, {
    rootPath: fixtureDir,
    pattern: NEEDLE,
    searchType: 'content',
    contextLines: 0,
    maxResults: MAX_RESULTS
  });

  // 5 of 200, all from the first file: unmarked, that reads like a tree with 5.
  assert.strictEqual(cutShortBy(state, 'max-results'), true,
    'a search stopped by maxResults must say so, not report a complete answer');

  const text = (await handleGetMoreSearchResults({ sessionId })).content[0].text;
  assert.ok(/maxResults/.test(text),
    `the caller must be told the search stopped at the limit, got: ${text.slice(0, 300)}`);
  console.log('✓ truncated search: marked as stopped at the limit');
}

async function testUntruncatedSearchIsNotFlagged(searchManager, handleGetMoreSearchResults, smallDir) {
  const { sessionId, state } = await runToCompletion(searchManager, {
    rootPath: smallDir,
    pattern: NEEDLE,
    searchType: 'content',
    contextLines: 0,
    maxResults: SMALL_MATCHES + 5
  });

  assert.strictEqual(state.totalMatches, SMALL_MATCHES,
    `expected the whole small fixture, got ${state.totalMatches}`);
  assert.ok(!cutShortBy(state, 'max-results'),
    'a search that never reached the limit must not be marked as truncated');
  assert.ok(!cutShortBy(state, 'time-limit'),
    'a search that ran to its own end must not be marked as cut short by time');

  const text = (await handleGetMoreSearchResults({ sessionId })).content[0].text;
  assert.ok(!/maxResults|time limit/.test(text),
    `a complete answer must not carry a truncation warning, got: ${text.slice(0, 300)}`);
  console.log('✓ complete search: no truncation mark');
}

// The Excel producer reports "<path>.xlsx:<sheet>!Row<n>", not a bare path
const isWorkbookResult = result => result.file.toLowerCase().includes('.xlsx');

async function testBudgetMetExactlyIsNotFlagged(searchManager, handleGetMoreSearchResults, smallDir) {
  // Nothing was left behind, so nothing may be claimed. This is also what pins
  // the cost of the rule: a collector that stopped the moment the budget filled
  // would have to mark this search, and would fail here.
  const { sessionId, state } = await runToCompletion(searchManager, {
    rootPath: smallDir,
    pattern: NEEDLE,
    searchType: 'content',
    contextLines: 0,
    maxResults: SMALL_MATCHES
  });

  assert.strictEqual(state.totalMatches, SMALL_MATCHES,
    `expected the whole small fixture, got ${state.totalMatches}`);
  assert.ok(!cutShortBy(state, 'max-results'),
    'a budget met exactly leaves nothing behind and must not be reported as cut short');

  const text = (await handleGetMoreSearchResults({ sessionId })).content[0].text;
  assert.ok(!/maxResults/.test(text),
    `nothing was missed, so nothing may warn about it, got: ${text.slice(0, 300)}`);
  console.log(`✓ budget met exactly: ${state.totalMatches} of ${SMALL_MATCHES}, no truncation mark`);
}

async function testOneMatchOverBudgetIsFlagged(searchManager, smallDir) {
  const wanted = SMALL_MATCHES - 1;
  const { state } = await runToCompletion(searchManager, {
    rootPath: smallDir,
    pattern: NEEDLE,
    searchType: 'content',
    contextLines: 0,
    maxResults: wanted
  });

  assert.strictEqual(state.totalMatches, wanted,
    `asked for ${wanted} of ${SMALL_MATCHES} matches, got ${state.totalMatches}`);
  assert.strictEqual(cutShortBy(state, 'max-results'), true,
    'one match past the budget is still a match left behind, and must be reported');
  console.log(`✓ one match over budget: ${state.totalMatches} of ${SMALL_MATCHES}, marked as cut short`);
}

async function testTimedOutSearchSaysSo(searchManager, handleGetMoreSearchResults, slowDir) {
  // A 1ms timer against half a second of walking: the kill lands mid-walk.
  const { sessionId, state } = await runToCompletion(searchManager, {
    rootPath: slowDir,
    pattern: NEEDLE,
    searchType: 'content',
    contextLines: 0,
    timeout: 1
  });

  const available = SLOW_FILES * SLOW_LINES;
  assert.ok(state.totalMatches < available,
    `the timeout must cut the search short, got all ${state.totalMatches} matches`);
  assert.strictEqual(cutShortBy(state, 'time-limit'), true,
    'a search cut short by its time limit must say so, not report a complete answer');

  const text = (await handleGetMoreSearchResults({ sessionId })).content[0].text;
  assert.ok(/time limit/.test(text),
    `the caller must be told the search ran out of time, got: ${text.slice(0, 300)}`);
  console.log(`✓ timed-out search: ${state.totalMatches} matches kept, marked as cut short`);
}

async function testOfficeProducerSharesTheBudget(searchManager, officeDir) {
  const { state } = await runToCompletion(searchManager, {
    rootPath: officeDir,
    pattern: NEEDLE,
    searchType: 'content',
    filePattern: '*.txt|*.xlsx',
    contextLines: 0,
    maxResults: MAX_RESULTS
  }, merged => merged.results.some(isWorkbookResult));

  const fromText = 2 * TEXT_MATCHES_PER_OFFICE_FILE;
  // 4 needles in text against a budget of 5: the workbook makes up the difference.
  assert.ok(state.results.some(isWorkbookResult),
    `expected workbook results in the session, got ${JSON.stringify(state.results.map(r => path.basename(r.file)))}`);
  assert.strictEqual(state.totalMatches, MAX_RESULTS,
    `ripgrep (${fromText} needles) and Excel must share one budget of ${MAX_RESULTS}, got ${state.totalMatches}`);
  console.log(`✓ Excel producer: exactly ${state.totalMatches} matches, both producers on one budget`);
}

/**
 * The workbook is searched on its own, so nothing but the Excel producer can
 * fill the budget or report it spent.
 */
async function testOfficeOnlySearchSaysItWasCutShort(searchManager, officeDir) {
  const { state } = await runToCompletion(searchManager, {
    rootPath: officeDir,
    pattern: NEEDLE,
    searchType: 'content',
    filePattern: '*.xlsx',
    contextLines: 0,
    maxResults: MAX_RESULTS
  }, merged => merged.totalMatches >= MAX_RESULTS);

  assert.strictEqual(state.totalMatches, MAX_RESULTS,
    `a workbook of ${OFFICE_MATCHES} needles against a budget of ${MAX_RESULTS} must keep ${MAX_RESULTS}, got ${state.totalMatches}`);
  assert.strictEqual(cutShortBy(state, 'max-results'), true,
    `the workbook held ${OFFICE_MATCHES} needles and ${MAX_RESULTS} came back: the answer was cut short and must say so`);
  console.log(`✓ Excel-only search: ${state.totalMatches} of ${OFFICE_MATCHES} kept, marked as cut short`);
}

async function main() {
  // Fixtures are built inside the try, so a failure still cleans up after itself.
  try {
    const home = makeTempHome();
    process.env.HOME = home;
    process.env.USERPROFILE = home;

    // Imported only now: dist/config.js reads os.homedir() at module scope.
    const { searchManager } = await import('../dist/search-manager.js');
    const { handleGetMoreSearchResults } = await import('../dist/handlers/search-handlers.js');

    const fixtureDir = makeFixture();
    const smallDir = makeSmallFixture();
    const spacedDir = makeSpacedFixture();
    const slowDir = makeSlowFixture();
    const officeDir = await makeOfficeFixture();

    console.log('=== start_search maxResults is a global limit ===\n');
    await testContentSearchCapsWholeSearch(searchManager, fixtureDir);
    await testFileSearchCapsWholeSearch(searchManager, fixtureDir);
    await testContextLinesAreNotCharged(searchManager, spacedDir);
    await testSearchWithoutLimitIsNotCut(searchManager, fixtureDir);
    await testTruncatedSearchSaysSo(searchManager, handleGetMoreSearchResults, fixtureDir);
    await testUntruncatedSearchIsNotFlagged(searchManager, handleGetMoreSearchResults, smallDir);
    await testBudgetMetExactlyIsNotFlagged(searchManager, handleGetMoreSearchResults, smallDir);
    await testOneMatchOverBudgetIsFlagged(searchManager, smallDir);
    await testTimedOutSearchSaysSo(searchManager, handleGetMoreSearchResults, slowDir);
    await testOfficeProducerSharesTheBudget(searchManager, officeDir);
    await testOfficeOnlySearchSaysItWasCutShort(searchManager, officeDir);
    console.log('\nAll maxResults tests passed.');
  } finally {
    tempDirs.forEach(removeQuietly);
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('✗ FAILED:', err.message);
  process.exit(1);
});
