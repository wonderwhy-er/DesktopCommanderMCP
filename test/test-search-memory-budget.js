/**
 * A session must bound the text it keeps, not just the number of entries
 * (GitHub issue #716). Budgets count characters, as String.length does.
 * HOME/USERPROFILE move first, so no run touches the real config file.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

const NEEDLE = 'BYTE_BUDGET_NEEDLE';
const COMPLETION_TIMEOUT_MS = 60000;

// Kept in step with src/search-manager.ts
const MAX_RESULT_TEXT_CHARS = 2000;
const MAX_RETAINED_TEXT_CHARS = 4 * 1024 * 1024;
const MAX_BUFFERED_LINE_CHARS = 1024 * 1024;

const tempDirs = [];

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeTempHome() {
  const home = makeTempDir('dc716-mem-home-');
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

/** Needles between very long lines, so the long text arrives as context. */
function makeLongContextFixture(files, needlesPerFile, lineChars) {
  const dir = makeTempDir('dc716-long-');
  const filler = 'x'.repeat(lineChars);
  const block = [filler, NEEDLE, filler].join('\n');
  const body = Array.from({ length: needlesPerFile }, () => block).join('\n');
  for (let i = 0; i < files; i++) {
    fs.writeFileSync(path.join(dir, `long${i}.txt`), `${body}\n`);
  }
  return dir;
}

/** One matching line larger than anything the collector may buffer. */
function makeOversizedLineFixture(lineBytes) {
  const dir = makeTempDir('dc716-oversized-');
  fs.writeFileSync(path.join(dir, 'huge.txt'), `${NEEDLE} ${'y'.repeat(lineBytes)}\n`);
  return dir;
}

async function runToCompletion(searchManager, options) {
  const { sessionId } = await searchManager.startSearch(options);
  const deadline = Date.now() + COMPLETION_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      const state = searchManager.readSearchResults(sessionId, 0, 1000000);
      if (state.isComplete) return { sessionId, state };
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`search did not complete within ${COMPLETION_TIMEOUT_MS}ms`);
  } finally {
    searchManager.terminateSearch(sessionId);
  }
}

const cutShortBy = (state, reason) => (state.shortfalls || []).includes(reason);

const retainedChars = results =>
  results.reduce((total, result) => total + (result.match?.length || 0) + result.file.length, 0);

async function testStoredEntriesAreCapped(searchManager) {
  const dir = makeLongContextFixture(10, 5, 100 * 1024);
  const { state } = await runToCompletion(searchManager, {
    rootPath: dir,
    pattern: NEEDLE,
    searchType: 'content',
    contextLines: 2
  });

  const longest = state.results.reduce((n, r) => Math.max(n, r.match?.length || 0), 0);
  assert.ok(longest <= MAX_RESULT_TEXT_CHARS,
    `a stored entry must be capped, longest is ${longest} chars`);
  assert.ok(retainedChars(state.results) < 1024 * 1024,
    `a search over long lines must not retain megabytes, retained ${retainedChars(state.results)} chars`);
  console.log(`✓ entry cap: ${state.results.length} entries, longest ${longest} chars, ` +
    `${(retainedChars(state.results) / 1024).toFixed(0)}KiB retained`);
}

async function testSessionStopsAtTheTextBudget(searchManager) {
  const dir = makeLongContextFixture(60, 20, 3000);
  const { state } = await runToCompletion(searchManager, {
    rootPath: dir,
    pattern: NEEDLE,
    searchType: 'content',
    contextLines: 2
  });

  // Checked before an entry is taken, so the last one can carry it just past.
  const ceiling = MAX_RETAINED_TEXT_CHARS + MAX_RESULT_TEXT_CHARS + 512;
  assert.ok(retainedChars(state.results) <= ceiling,
    `retained ${retainedChars(state.results)} chars against a ceiling of ${ceiling}`);
  assert.strictEqual(cutShortBy(state, 'output-size'), true,
    'a search stopped by the text budget must say so, not report a complete answer');
  assert.ok(state.totalMatches < 60 * 20,
    `the budget must cut the search short, got all ${state.totalMatches} matches`);
  console.log(`✓ text budget: stopped at ${state.totalMatches} matches, ` +
    `${(retainedChars(state.results) / 1024 / 1024).toFixed(1)}MiB retained`);
}

async function testOversizedLineIsDropped(searchManager) {
  const dir = makeOversizedLineFixture(4 * MAX_BUFFERED_LINE_CHARS);
  const { state } = await runToCompletion(searchManager, {
    rootPath: dir,
    pattern: NEEDLE,
    searchType: 'content',
    contextLines: 0
  });

  assert.strictEqual(cutShortBy(state, 'output-size'), true,
    'a line too large to buffer must be reported, not silently dropped or silently kept');
  assert.strictEqual(state.totalMatches, 0,
    `the oversized line must not be collected, got ${state.totalMatches} matches`);
  console.log('✓ oversized line: dropped and reported');
}

async function testLongLineFixtureIsNotRetained(searchManager) {
  // Retention fell 78.2MiB -> 1.6MiB here while peak heap stayed at 140.8MiB:
  // the budget bounds what a session holds, not what parsing costs on the way.
  const dir = makeLongContextFixture(40, 10, 100 * 1024);
  const before = process.memoryUsage().heapUsed;
  const { state } = await runToCompletion(searchManager, {
    rootPath: dir,
    pattern: NEEDLE,
    searchType: 'content',
    contextLines: 2
  });
  const grew = process.memoryUsage().heapUsed - before;
  const retained = retainedChars(state.results);

  assert.ok(retained <= MAX_RETAINED_TEXT_CHARS,
    `a 39MiB fixture of long lines left ${(retained / 1024 / 1024).toFixed(1)}MiB retained`);
  assert.ok(state.results.length >= 400,
    `the answer must survive the budget, got ${state.results.length} entries`);
  console.log(`✓ long lines: ${state.results.length} entries, ` +
    `${(retained / 1024 / 1024).toFixed(1)}MiB retained (heap moved ${(grew / 1024 / 1024).toFixed(1)}MiB, parsing not retention)`);
}

async function testBudgetHoldsParentMemory(searchManager) {
  // Measured in a process of its own on this fixture: heap +57.1MiB before the
  // budget, +26.4MiB after, so the threshold sits between. On a fixture whose
  // results fit the budget the peak is all parsing and does not move at all,
  // which is why the case needs one the budget stops.
  const dir = makeLongContextFixture(18, 500, 3000);
  const before = process.memoryUsage().heapUsed;
  const { state } = await runToCompletion(searchManager, {
    rootPath: dir,
    pattern: NEEDLE,
    searchType: 'content',
    contextLines: 2
  });
  const grew = process.memoryUsage().heapUsed - before;

  assert.strictEqual(cutShortBy(state, 'output-size'), true, 'the fixture must be large enough to spend the budget');
  assert.ok(grew < 42 * 1024 * 1024,
    `parent heap grew ${(grew / 1024 / 1024).toFixed(1)}MiB on a fixture whose results do not fit the budget`);
  // The figures the PR quotes for this fixture, so a run reproduces them
  const longest = state.results.reduce((n, r) => Math.max(n, r.match?.length || 0), 0);
  console.log(`✓ parent memory: +${(grew / 1024 / 1024).toFixed(1)}MiB heap, ` +
    `${state.totalMatches} matches kept of ${18 * 500}, ` +
    `${(retainedChars(state.results) / 1024 / 1024).toFixed(1)}MiB retained, longest entry ${longest} chars`);
}

async function main() {
  try {
    const home = makeTempHome();
    process.env.HOME = home;
    process.env.USERPROFILE = home;

    const { searchManager } = await import('../dist/search-manager.js');

    console.log('=== a search session bounds the bytes it keeps ===\n');
    await testStoredEntriesAreCapped(searchManager);
    await testSessionStopsAtTheTextBudget(searchManager);
    await testOversizedLineIsDropped(searchManager);
    await testLongLineFixtureIsNotRetained(searchManager);
    await testBudgetHoldsParentMemory(searchManager);
    console.log('\nAll text budget tests passed.');
  } finally {
    tempDirs.forEach(removeQuietly);
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('✗ FAILED:', err.message);
  process.exit(1);
});
