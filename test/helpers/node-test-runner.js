import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { run } from 'node:test';
import { tap } from 'node:test/reporters';
import { fileURLToPath, pathToFileURL } from 'url';

/**
 * Runs test files through Node's test runner (node:test) the way our runners
 * always have: each file in its own Node process, started in the file's folder,
 * one after another, with its own temporary home (helpers/test-home.js). A file
 * passes when its process exits with 0, so test files don't need to use node:test;
 * files that do also report each of their tests.
 *
 * Writes, in outDir:
 * - junit.xml: one testcase per file (a failure carries the file's last output
 *   lines), one per check skip() skipped, one per test of a node:test file;
 * - results.json: the same facts as JSON, for scripts and agents;
 * - results.tap: node:test's TAP report.
 */

const HELPERS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HELPERS_DIR, '..', '..');
const TEST_HOME_HOOK = pathToFileURL(path.join(HELPERS_DIR, 'test-home.js')).href;
const OUTPUT_TAIL_LINES = 40;

const toPosix = (file) => file.split(path.sep).join('/');
const sameFile = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
// The event of the file's own test (its whole process), not of a test inside a node:test file
const isFileEvent = (data, entry) => data.nesting === 0 && sameFile(path.resolve(data.name), entry.path);

/**
 * Runs `files` (paths relative to `dir`) and returns one result per file:
 * { file, path, success, exitCode, duration, skipped, tests, outputTail }.
 * onFileStart(file) and onFileEnd(result) let the caller print its own lines.
 * `excluded`: the files in `dir` the runner left out by test/excluded.txt, which
 * results.json lists with their reasons.
 */
export async function runTestFiles({ dir, files, outDir, suiteName, timeoutMs = Infinity, shard, excluded = [], onFileStart, onFileEnd }) {
  const startedAt = new Date();
  const excludedTests = excludedEntries(dir, excluded);
  if (files.length === 0) {
    // node:test's run() looks for test files by itself when it is given none
    writeReports({ outDir, suiteName, startedAt, results: [], excluded: excludedTests });
    return [];
  }
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-test-run-'));
  const entries = files.map((file) => ({
    file,
    path: path.resolve(dir, file),
    status: 'no result',
    exitCode: undefined,
    started: undefined,
    lastEvent: undefined,
    fileDuration: undefined,
    tests: [],
    output: [],
    ended: false,
  }));
  const entryFor = (file) => file && entries.find((entry) => sameFile(entry.path, path.resolve(dir, file)));

  // node:test starts each file's process in the current folder: the files expect theirs
  const previousCwd = process.cwd();
  const previousRunDir = process.env.DC_TEST_RUN_DIR;
  process.chdir(dir);
  process.env.DC_TEST_RUN_DIR = runDir;
  // A runner a test file starts (test-runner-arguments.js starts run-repro.js) inherits
  // that file's NODE_TEST_CONTEXT, and node:test's run() then skips every file as a
  // recursive call. This process is a runner of its own, not part of the test file's run.
  delete process.env.NODE_TEST_CONTEXT;

  const tapEvents = new Readable({ objectMode: true, read() {} });
  fs.mkdirSync(outDir, { recursive: true });
  const tapFile = fs.createWriteStream(path.join(outDir, 'results.tap'));
  const tapDone = new Promise((resolve) => tapFile.on('finish', resolve));
  Readable.from(tap(tapEvents)).pipe(tapFile);

  let current;
  const finish = (entry) => {
    if (!entry || entry.ended) return;
    entry.ended = true;
    const result = toResult(entry, runDir);
    entry.result = result;
    onFileEnd?.(result);
  };

  try {
    const stream = run({
      files: entries.map((entry) => entry.path),
      concurrency: 1,
      timeout: timeoutMs,
      execArgv: ['--import', TEST_HOME_HOOK],
      ...(shard ? { shard } : {}),
    });
    for await (const event of stream) {
      tapEvents.push(event);
      const { type, data } = event;
      const entry = entryFor(data?.file);
      if (!entry) continue;
      // Every file is queued at the start; its other events come once its process runs
      if (type === 'test:enqueue') continue;
      entry.lastEvent = Date.now();
      if (entry.started === undefined) {
        if (current && current !== entry) finish(current);
        current = entry;
        entry.started = Date.now();
        onFileStart?.(entry.file);
      }
      if (type === 'test:stdout' || type === 'test:stderr') {
        (type === 'test:stdout' ? process.stdout : process.stderr).write(data.message);
        entry.output.push(...data.message.split(/\r?\n/));
        entry.output.splice(0, Math.max(0, entry.output.length - OUTPUT_TAIL_LINES * 2));
      } else if (type === 'test:pass' || type === 'test:fail') {
        recordTest(entry, type, data);
        if (isFileEvent(data, entry)) finish(entry);
      }
    }
  } finally {
    // A sharded run starts only its share of the files; any other file that never started has no result
    entries.filter((entry) => !shard || entry.started !== undefined).forEach(finish);
    tapEvents.push(null);
    await tapDone;
    process.chdir(previousCwd);
    if (previousRunDir === undefined) delete process.env.DC_TEST_RUN_DIR;
    else process.env.DC_TEST_RUN_DIR = previousRunDir;
  }

  const ran = shard ? entries.filter((entry) => entry.started !== undefined) : entries;
  const results = ran.map((entry) => entry.result);
  removeTestHomes(runDir);
  writeReports({ outDir, suiteName, startedAt, results, excluded: excludedTests });
  return results;
}

/** A pass or fail event: the file's own (the whole process) or one test in a node:test file */
function recordTest(entry, type, data) {
  const failed = type === 'test:fail' && !data.todo;
  const error = data.details?.error;
  if (isFileEvent(data, entry)) {
    entry.fileDuration = data.details?.duration_ms;
    if (failed) entry.exitCode = error?.failureType === 'testTimeoutFailure' ? 'timeout' : error?.exitCode ?? error?.signal ?? 1;
  } else {
    entry.tests.push({
      name: data.name,
      status: failed ? 'failed' : data.skip !== undefined && data.skip !== false ? 'skipped' : 'passed',
      duration: Math.round(data.details?.duration_ms ?? 0),
      message: failed ? String(error?.cause?.message ?? error?.cause ?? error?.message ?? 'failed') : undefined,
    });
  }
  if (failed) entry.status = 'failed';
  else if (entry.status === 'no result') entry.status = 'passed';
}

function toResult(entry, runDir) {
  const name = path.basename(entry.path);
  const skipFile = path.join(runDir, `${name}.skips.txt`);
  const skipped = fs.existsSync(skipFile) ? fs.readFileSync(skipFile, 'utf8').split('\n').filter(Boolean) : [];
  const success = entry.status === 'passed';
  const measured = entry.started !== undefined ? (entry.lastEvent ?? Date.now()) - entry.started : 0;
  return {
    file: entry.file,
    path: toPosix(path.relative(ROOT, entry.path)),
    success,
    exitCode: success ? 0 : entry.exitCode ?? 1,
    duration: Math.round(entry.fileDuration ?? measured),
    skipped,
    tests: entry.tests,
    outputTail: success ? undefined : entry.output.join('\n').trimEnd().split('\n').slice(-OUTPUT_TAIL_LINES).join('\n'),
  };
}

/** Homes a file's process couldn't remove at its exit (a child still held a file, or it was stopped) */
function removeTestHomes(runDir) {
  for (const record of fs.readdirSync(runDir).filter((file) => file.endsWith('.home.txt'))) {
    const home = fs.readFileSync(path.join(runDir, record), 'utf8');
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  fs.rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function writeReports({ outDir, suiteName, startedAt, results, excluded }) {
  const duration = Date.now() - startedAt.getTime();
  fs.mkdirSync(outDir, { recursive: true });
  const summary = {
    files: results.length,
    passed: results.filter((result) => result.success).length,
    failed: results.filter((result) => !result.success).length,
    skippedChecks: results.reduce((count, result) => count + result.skipped.length, 0),
    duration,
  };
  fs.writeFileSync(path.join(outDir, 'results.json'), `${JSON.stringify({
    suite: suiteName,
    node: process.version,
    platform: process.platform,
    started: startedAt.toISOString(),
    summary,
    files: results,
    excluded,
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, 'junit.xml'), junitXml({ suiteName, startedAt, duration, results }));
}

// XML 1.0 allows no control characters but tab and newlines (test output carries ANSI colors)
const xmlText = (text) => String(text)
  .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
  .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const seconds = (ms) => (ms / 1000).toFixed(3);

function junitXml({ suiteName, startedAt, duration, results }) {
  const cases = [];
  for (const result of results) {
    const attrs = `classname="${xmlText(path.posix.dirname(result.path))}" name="${xmlText(path.posix.basename(result.path))}" file="${xmlText(result.path)}" time="${seconds(result.duration)}"`;
    if (result.success) {
      cases.push(`    <testcase ${attrs}/>`);
    } else {
      cases.push([
        `    <testcase ${attrs}>`,
        `      <failure message="exit code ${xmlText(result.exitCode)}" type="exit">${xmlText(result.outputTail ?? '')}</failure>`,
        '    </testcase>',
      ].join('\n'));
    }
    for (const reason of result.skipped) {
      cases.push([
        `    <testcase classname="${xmlText(result.path)}" name="skipped: ${xmlText(reason)}" file="${xmlText(result.path)}" time="0">`,
        `      <skipped message="${xmlText(reason)}"/>`,
        '    </testcase>',
      ].join('\n'));
    }
    for (const test of result.tests) {
      const testAttrs = `classname="${xmlText(result.path)}" name="${xmlText(test.name)}" file="${xmlText(result.path)}" time="${seconds(test.duration)}"`;
      const inner = test.status === 'failed'
        ? `      <failure message="${xmlText(test.message)}" type="test"/>`
        : test.status === 'skipped' ? '      <skipped/>' : undefined;
      cases.push(inner ? `    <testcase ${testAttrs}>\n${inner}\n    </testcase>` : `    <testcase ${testAttrs}/>`);
    }
  }
  const failures = results.filter((result) => !result.success).length
    + results.reduce((count, result) => count + result.tests.filter((test) => test.status === 'failed').length, 0);
  const skipped = results.reduce((count, result) => count + result.skipped.length
    + result.tests.filter((test) => test.status === 'skipped').length, 0);
  const counts = `tests="${cases.length}" failures="${failures}" errors="0" skipped="${skipped}" time="${seconds(duration)}"`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="desktop-commander" ${counts}>`,
    `  <testsuite name="${xmlText(suiteName)}" ${counts} timestamp="${startedAt.toISOString()}" hostname="${xmlText(os.hostname())}">`,
    ...cases,
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n');
}

// The old names of --timed and --without-timed: a runner that ignored them would run timed tests where they're meant to be left out
const RENAMED = { '--run-alone': '--timed', '--without-run-alone': '--without-timed' };

/**
 * Options every runner takes: --out <dir>, --shard <i>/<n>, --changed [A [B]],
 * --skip <name>, --timed, --without-timed; the rest are the runner's own
 */
export function readRunnerArgs(argv, defaultOutDir) {
  const options = { outDir: defaultOutDir, shard: undefined, flags: new Set(), values: {}, names: [], skip: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (RENAMED[arg]) throw new Error(`${arg} is now ${RENAMED[arg]}`);
    if (arg === '--out') options.outDir = path.resolve(argv[++i]);
    else if (arg === '--shard') {
      const [index, total] = argv[++i].split('/').map(Number);
      options.shard = { index, total };
    } else if (arg === '--changed') {
      // Up to two commits, A [B]: the next words, unless they are options or test files
      const commits = [];
      const isCommit = (word) => word && !word.startsWith('--') && !word.endsWith('.js');
      while (commits.length < 2 && isCommit(argv[i + 1])) commits.push(argv[++i]);
      options.values.changed = commits;
    } else if (arg === '--skip') options.skip.push(path.basename(argv[++i]));
    else if (arg.startsWith('--')) options.flags.add(arg);
    else options.names.push(arg);
  }
  return options;
}

/** The names left after --skip <name> (any number of times) */
export function withoutSkipped(names, options) {
  return names.filter((name) => !options.skip.includes(path.basename(name)));
}

/**
 * The files each runner finds by name in its folder under test/ ('' for the
 * suite's own): the one rule the runners and the test lists share
 */
const FOUND_BY_NAME = {
  '': (file) => file.endsWith('.js') && (file.startsWith('test') || file.endsWith('.test.js')) && file !== 'run-all-tests.js',
  repro: (file) => file.startsWith('test-') && file.endsWith('.js'),
  integration: (file) => file.endsWith('.js') && file !== 'run-all-integration-tests.js',
  docker: (file) => file.startsWith('test-') && file.endsWith('.js'),
};

/** The test files a runner finds among its folder's `files` ('' for the suite), sorted */
export function testsIn(folder, files) {
  return files.filter(FOUND_BY_NAME[folder]).sort();
}

/**
 * The test files a runner given no names finds in `dir`, its folder ('' for the
 * suite). Fail closed: finding none is an error, not a pass with nothing run;
 * filters after this (--timed, --skip, --changed, a shard) may still leave none.
 */
export function findTests(folder, dir) {
  const found = testsIn(folder, fs.readdirSync(dir));
  if (found.length === 0) throw new Error(`No test file found in ${dir}: no file there is one this runner runs`);
  return found;
}

/**
 * The entries of test/<list>.txt, 'timed' or 'excluded', as [{ name, reason }]:
 * one test per line, "<name>  # <reason>", the name relative to test/ (a suite
 * file by its name, the others as repro/<name>, integration/<name> or
 * docker/<name>). Blank lines and lines starting with # are comments. A line
 * without a reason, naming a file that isn't there, or naming one no runner
 * finds by name (a line that would do nothing) stops the run with the list and
 * the line. `dir`: the folder of the lists and the tests, test/ by default;
 * DC_TEST_LISTS_DIR moves only the lists (the runners' own tests use it).
 */
export function readTestList(list, { dir } = {}) {
  const testDir = dir ?? path.join(ROOT, 'test');
  const listFile = path.join(dir ?? process.env.DC_TEST_LISTS_DIR ?? testDir, `${list}.txt`);
  const fromRoot = path.relative(ROOT, listFile);
  const where = (index) => `${fromRoot.startsWith('..') || path.isAbsolute(fromRoot) ? listFile : toPosix(fromRoot)}:${index + 1}`;
  return fs.readFileSync(listFile, 'utf8').split(/\r?\n/).flatMap((line, index) => {
    if (/^\s*(#|$)/.test(line)) return [];
    const hash = line.indexOf('#');
    const name = (hash < 0 ? line : line.slice(0, hash)).trim();
    const reason = hash < 0 ? '' : line.slice(hash + 1).trim();
    if (!reason) throw new Error(`${where(index)}: "${name}" has no reason: write "${name}  # <why>"`);
    if (!fs.existsSync(path.join(testDir, name))) {
      throw new Error(`${where(index)}: "${name}" isn't a file in test/: renamed or deleted? Change or take out its line`);
    }
    const folder = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '';
    if (!FOUND_BY_NAME[folder]?.(path.posix.basename(name))) {
      const hint = name.endsWith('.ps1') ? ': test-powershell-tests.js runs the PowerShell tests, so list that' : '';
      throw new Error(`${where(index)}: "${name}" isn't a test a runner finds by name, so the line would do nothing${hint}`);
    }
    return [{ name, reason }];
  });
}

/** The names in test/timed.txt: the timed tests, whose result depends on time, run on a quiet machine */
export function timedNames() {
  return readTestList('timed').map(({ name }) => name);
}

/** The names in test/excluded.txt: the tests that never run in CI, each for its reason */
export function excludedNames() {
  return readTestList('excluded').map(({ name }) => name);
}

/** Of a list's names, the file names of those in `folder` under test/ ('' for the suite's own) */
function inFolder(names, folder) {
  return new Set(names.filter((name) => (folder ? name.startsWith(`${folder}/`) : !name.includes('/'))).map((name) => path.basename(name)));
}

/**
 * The files a runner found, less the excluded ones in its `folder` (as byTimed
 * takes it). A runner applies it to the files it finds, not to files named on its
 * command line, so an excluded test can still be run by name.
 */
export function withoutExcluded(names, folder) {
  const excluded = inFolder(excludedNames(), folder);
  return names.filter((name) => !excluded.has(path.basename(name)));
}

/** The files in `dir` a runner left out, as test/excluded.txt names them, with their reasons */
function excludedEntries(dir, names) {
  if (names.length === 0) return [];
  const reasons = new Map(readTestList('excluded').map(({ name, reason }) => [name, reason]));
  return names.map((name) => {
    const listed = toPosix(path.relative(path.join(ROOT, 'test'), path.resolve(dir, name)));
    return { name: listed, reason: reasons.get(listed) };
  });
}

/**
 * A runner's files after --timed (only the timed ones) or --without-timed (all
 * but them); neither keeps every file. `folder` is the runner's folder under
 * test/ as the lists name it: '' for the suite, 'repro', 'integration', 'docker'.
 */
export function byTimed(names, options, folder) {
  const only = options.flags.has('--timed');
  if (!only && !options.flags.has('--without-timed')) return names;
  const timed = inFolder(timedNames(), folder);
  return names.filter((name) => timed.has(path.basename(name)) === only);
}
