/**
 * What the budget work touched but never checked: the DOCX producer, paging,
 * cancellation, cleanup, retention, and that a session waits for the producers
 * it started (GitHub issue #716 asks that cancellation,
 * truncation and cleanup preserve useful results). HOME/USERPROFILE move first.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

const NEEDLE = 'LIFECYCLE_NEEDLE';
const MAX_RESULTS = 5;
const TEXT_MATCHES_PER_FILE = 2;
const COMPLETION_TIMEOUT_MS = 30000;

const tempDirs = [];

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeTempHome() {
  const home = makeTempDir('dc716-life-home-');
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

function removeQuietly(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Temp directory; the config watcher can still hold it on Windows.
  }
}

/**
 * The budget fills only if both producers land, so the case fails whether DOCX
 * adds on top of it or adds nothing at all. The document is the smallest thing
 * searchDocxFiles() reads: a zip with a word/document.xml of <w:t> runs.
 */
async function makeDocxFixture() {
  const dir = makeTempDir('dc716-docx-');
  const body = Array.from({ length: TEXT_MATCHES_PER_FILE }, (_, line) => `line ${line} ${NEEDLE}`).join('\n');
  for (let i = 0; i < 2; i++) {
    fs.writeFileSync(path.join(dir, `text${i}.txt`), `${body}\n`);
  }

  const PizZip = (await import('pizzip')).default;
  const runs = Array.from({ length: 6 }, (_, i) => `<w:p><w:r><w:t>run ${i} ${NEEDLE}</w:t></w:r></w:p>`).join('');
  const zip = new PizZip();
  zip.file('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('word/document.xml',
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${runs}</w:body></w:document>`);
  fs.writeFileSync(path.join(dir, 'doc.docx'), zip.generate({ type: 'nodebuffer' }));
  return dir;
}

/**
 * One tiny text file against a workbook large enough that parsing it outlasts
 * the ripgrep walk: 8000 rows land about 65ms after the child closes, which is
 * the window a session must not declare itself complete in.
 */
async function makeSlowProducerFixture() {
  const dir = makeTempDir('dc716-slow-producer-');
  fs.writeFileSync(path.join(dir, `one.txt`), `line ${NEEDLE}
`);

  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  for (let i = 0; i < SLOW_PRODUCER_ROWS; i++) sheet.addRow([`row ${i} ${NEEDLE}`]);
  await workbook.xlsx.writeFile(path.join(dir, 'book.xlsx'));
  return dir;
}

/** Enough entries that a truncated session has pages to walk. */
function makePagingFixture(files, matchesPerFile) {
  const dir = makeTempDir('dc716-paging-');
  const body = Array.from({ length: matchesPerFile }, (_, line) => `line ${line} ${NEEDLE}`).join('\n');
  for (let i = 0; i < files; i++) {
    fs.writeFileSync(path.join(dir, `page${i}.txt`), `${body}\n`);
  }
  return dir;
}

/** Large enough that a search over it is still running when we cancel it. */
function makeSlowFixture() {
  const dir = makeTempDir('dc716-life-slow-');
  const body = Array.from({ length: 40 }, (_, line) => `line ${line} ${NEEDLE}`).join('\n');
  for (let i = 0; i < 1200; i++) {
    fs.writeFileSync(path.join(dir, `slow${i}.txt`), `${body}\n`);
  }
  return dir;
}

async function runToCompletion(searchManager, options, until = null) {
  const { sessionId } = await searchManager.startSearch(options);
  const deadline = Date.now() + COMPLETION_TIMEOUT_MS;
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
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`search did not complete within ${COMPLETION_TIMEOUT_MS}ms`);
}

const isDocxResult = result => result.file.toLowerCase().includes('.docx');
const isWorkbookResult = result => result.file.toLowerCase().includes('.xlsx');
const SLOW_PRODUCER_ROWS = 8000;

async function testDocxProducerSharesTheBudget(searchManager, docxDir) {
  const { sessionId, state } = await runToCompletion(searchManager, {
    rootPath: docxDir,
    pattern: NEEDLE,
    searchType: 'content',
    filePattern: '*.txt|*.docx',
    contextLines: 0,
    maxResults: MAX_RESULTS
  }, merged => merged.results.some(isDocxResult));

  assert.ok(state.results.some(isDocxResult),
    `expected document results in the session, got ${JSON.stringify(state.results.map(r => path.basename(r.file)))}`);
  assert.strictEqual(state.totalMatches, MAX_RESULTS,
    `ripgrep (${2 * TEXT_MATCHES_PER_FILE} needles) and DOCX must share one budget of ${MAX_RESULTS}, got ${state.totalMatches}`);
  searchManager.terminateSearch(sessionId);
  console.log(`✓ DOCX producer: exactly ${state.totalMatches} matches across both producers`);
}

async function testCompletionWaitsForOfficeProducers(searchManager, slowDir) {
  // No `until` here on purpose: the first moment the session calls itself
  // complete is the moment its answer has to be whole.
  const { sessionId, state } = await runToCompletion(searchManager, {
    rootPath: slowDir,
    pattern: NEEDLE,
    searchType: 'content',
    filePattern: '*.txt|*.xlsx',
    contextLines: 0
  });

  assert.ok(state.results.some(isWorkbookResult),
    'a session is not complete while a producer it started is still running');
  searchManager.terminateSearch(sessionId);
  console.log(`✓ completion: ${state.results.length} results, document among them, at the first complete read`);
}

async function testCancellationReachesOfficeProducers(searchManager, slowDir) {
  // Cancelling has to reach every producer the session started, or the session
  // waits for a reader nobody wants any more.
  const { sessionId } = await searchManager.startSearch({
    rootPath: slowDir,
    pattern: NEEDLE,
    searchType: 'content',
    filePattern: '*.txt|*.xlsx',
    contextLines: 0
  });

  await new Promise(resolve => setTimeout(resolve, 40));
  const cancelledAt = Date.now();
  searchManager.terminateSearch(sessionId);

  const deadline = cancelledAt + COMPLETION_TIMEOUT_MS;
  let state = searchManager.readSearchResults(sessionId, 0, 100000);
  while (!state.isComplete && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
    state = searchManager.readSearchResults(sessionId, 0, 100000);
  }

  assert.strictEqual(state.isComplete, true, 'a cancelled search must settle');
  assert.ok(state.totalMatches < SLOW_PRODUCER_ROWS,
    `cancelling must stop the workbook reader, it kept ${state.totalMatches} of ${SLOW_PRODUCER_ROWS} rows`);
  console.log(`✓ cancellation reaches producers: ${state.totalMatches} of ${SLOW_PRODUCER_ROWS} rows kept, settled in ${Date.now() - cancelledAt}ms`);
}

async function testTruncatedAnswerPages(searchManager, pagingDir) {
  const { sessionId, state } = await runToCompletion(searchManager, {
    rootPath: pagingDir,
    pattern: NEEDLE,
    searchType: 'content',
    contextLines: 0,
    maxResults: 10
  });
  assert.strictEqual(state.totalMatches, 10, `expected a truncated session, got ${state.totalMatches}`);

  const first = searchManager.readSearchResults(sessionId, 0, 4);
  assert.strictEqual(first.returnedCount, 4, `first page returned ${first.returnedCount}`);
  assert.strictEqual(first.hasMoreResults, true, 'a first page of four out of ten has more to come');

  const second = searchManager.readSearchResults(sessionId, 4, 4);
  assert.strictEqual(second.returnedCount, 4, `second page returned ${second.returnedCount}`);
  assert.notStrictEqual(second.results[0].line, first.results[0].line,
    'the second page must not repeat the first');

  const last = searchManager.readSearchResults(sessionId, 8, 4);
  assert.strictEqual(last.returnedCount, 2, `last page returned ${last.returnedCount}`);
  assert.strictEqual(last.hasMoreResults, false, 'the last page of a finished session has nothing after it');

  const all = searchManager.readSearchResults(sessionId, 0, 100000);
  const tail = searchManager.readSearchResults(sessionId, -3, 100);
  assert.strictEqual(tail.returnedCount, 3, `tail returned ${tail.returnedCount}`);
  assert.deepStrictEqual(tail.results, all.results.slice(-3),
    'the tail must be the end of the same answer');

  const past = searchManager.readSearchResults(sessionId, 50, 10);
  assert.strictEqual(past.returnedCount, 0, 'reading past the end returns nothing');
  assert.strictEqual(past.totalMatches, 10, 'reading past the end does not change the totals');

  searchManager.terminateSearch(sessionId);
  console.log('✓ paging: ranges, tail and hasMoreResults over a truncated answer');
}

async function testCancelledSearchKeepsWhatItHad(searchManager, slowDir) {
  const { sessionId } = await searchManager.startSearch({
    rootPath: slowDir,
    pattern: NEEDLE,
    searchType: 'content',
    contextLines: 0
  });

  const before = searchManager.readSearchResults(sessionId, 0, 100000);
  assert.strictEqual(before.isComplete, false, 'the fixture must be large enough to still be running');

  assert.strictEqual(searchManager.terminateSearch(sessionId), true, 'cancelling a live session reports success');

  const deadline = Date.now() + COMPLETION_TIMEOUT_MS;
  let after = searchManager.readSearchResults(sessionId, 0, 100000);
  while (!after.isComplete && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
    after = searchManager.readSearchResults(sessionId, 0, 100000);
  }

  assert.strictEqual(after.isComplete, true, 'a cancelled search must settle');
  assert.ok(after.totalMatches >= before.totalMatches,
    `cancelling must not lose what was collected: had ${before.totalMatches}, then ${after.totalMatches}`);
  assert.ok(after.totalMatches < 1200 * 40,
    `cancelling must actually stop the walk, got all ${after.totalMatches} matches`);
  assert.strictEqual(searchManager.terminateSearch(sessionId), true,
    'cancelling twice is not an error, the session is still there to read');
  console.log(`✓ cancellation: ${after.totalMatches} matches kept and readable after the stop`);
}

function testCleanupRemovesFinishedSessions(searchManager, sessionId, liveSessionId) {
  const listed = () => searchManager.listSearchSessions().map(s => s.id);
  assert.ok(listed().includes(sessionId), 'the finished session is there before cleanup');

  // maxAge 0: everything finished is old enough
  searchManager.cleanupSessions(0);
  assert.ok(!listed().includes(sessionId), 'cleanup removes a finished session');
  assert.throws(() => searchManager.readSearchResults(sessionId, 0, 10), /not found/,
    'a cleaned session is gone, not silently empty');

  assert.ok(listed().includes(liveSessionId), 'cleanup leaves a running session alone');
  console.log('✓ cleanup: finished session removed, running session kept');
}

function testReadDoesNotFreeResults(searchManager, sessionId) {
  const first = searchManager.readSearchResults(sessionId, 0, 100000);
  const again = searchManager.readSearchResults(sessionId, 0, 100000);

  assert.strictEqual(again.totalMatches, first.totalMatches,
    'reading a session does not consume it');
  assert.deepStrictEqual(again.results, first.results,
    'a second read gives the same answer, so results are not freed on read');
  console.log(`✓ retention: ${again.results.length} entries still readable after a full read`);
}

async function main() {
  try {
    const home = makeTempHome();
    process.env.HOME = home;
    process.env.USERPROFILE = home;

    const { searchManager } = await import('../dist/search-manager.js');

    const docxDir = await makeDocxFixture();
    const pagingDir = makePagingFixture(5, 10);
    const slowDir = makeSlowFixture();
    const slowProducerDir = await makeSlowProducerFixture();

    console.log('=== search session lifecycle ===\n');
    await testDocxProducerSharesTheBudget(searchManager, docxDir);
    await testCompletionWaitsForOfficeProducers(searchManager, slowProducerDir);
    await testCancellationReachesOfficeProducers(searchManager, slowProducerDir);
    await testTruncatedAnswerPages(searchManager, pagingDir);
    await testCancelledSearchKeepsWhatItHad(searchManager, slowDir);

    // A finished session to clean up, and a running one that must survive it
    const { sessionId: finished } = await runToCompletion(searchManager, {
      rootPath: pagingDir, pattern: NEEDLE, searchType: 'content', contextLines: 0
    });
    testReadDoesNotFreeResults(searchManager, finished);
    const { sessionId: live } = await searchManager.startSearch({
      rootPath: slowDir, pattern: NEEDLE, searchType: 'content', contextLines: 0
    });
    testCleanupRemovesFinishedSessions(searchManager, finished, live);
    searchManager.terminateSearch(live);

    console.log('\nAll session lifecycle tests passed.');
  } finally {
    tempDirs.forEach(removeQuietly);
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('✗ FAILED:', err.message);
  process.exit(1);
});
