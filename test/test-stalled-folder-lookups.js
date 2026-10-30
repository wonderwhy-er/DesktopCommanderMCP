/**
 * A folder whose lookups stop answering (a network share that hangs) must not
 * hold up other folders, and must work again once it answers.
 *
 * validatePath() (src/tools/filesystem.ts) looks every path up on the disk
 * with fs.promises.realpath before a file operation. Here that lookup waits,
 * for a folder and every path in it, until the test lets it answer. Expected:
 *   - at most LOOKUPS_PER_FOLDER lookups in that folder run at a time; the
 *     others wait in line
 *   - a lookup that waited in line still runs in its own tool call: what that
 *     call sends to telemetry afterwards has the path it resolved to replaced
 *     whole
 *   - a lookup that has had its turn for more than 10 seconds fails with an
 *     error that names its path, instead of "__ERROR__: Path validation
 *     operation timed out after 10 seconds", and is sent to telemetry once,
 *     as server_path_validation_timeout
 *   - while that lookup still waits, its path, or a path below it, fails at
 *     once with the same error, without a lookup on the disk. Other paths in
 *     its folder still work
 *   - once a second, different path in the folder hangs too, the folder
 *     itself, or a path in or below it, fails at once with an error that
 *     names the folder, and so do the lookups waiting in line there
 *   - a path in another folder still works
 *   - a lookup's 10 seconds start when it gets its turn, not while it waits
 *     in line: in a slow folder whose lookups each answer well within 10
 *     seconds, every lookup answers, also the last ones in line
 *   - once the waiting lookups answer, the folder works again
 *   - a root is never marked stalled: when the lookups of folders in it don't
 *     answer, as hung mount points don't, a path elsewhere on it still works
 *   - a root is its own folder: when every turn in its line is held by a
 *     lookup that ran out of time, the lookups of the root itself waiting in
 *     line fail at once, so no more than LOOKUPS_PER_FOLDER lookups there
 *     reach the disk
 *
 * Telemetry is caught the way test-telemetry-paths.js catches it. Takes about
 * 20 seconds: a lookup's own time limit, twice. Runs as part of `npm test`, or
 * alone: node test/run-all-tests.js test-stalled-folder-lookups.js
 */
import { EventEmitter } from 'events';
import fs from 'fs';
import fsPromises from 'fs/promises';
import https from 'https';
import { syncBuiltinESMExports } from 'module';
import path from 'path';
import { createTempDir, isTestHome } from './helpers/test-env.js';
import { runIfMain, skip } from './helpers/run-if-main.js';
import { waitUntil } from './helpers/wait.js';

// Every telemetry payload this process would send
const sent = [];
https.request = (options, callback) => {
  const chunks = [];
  const req = new EventEmitter();
  req.write = (data) => { chunks.push(String(data)); return true; };
  req.setTimeout = () => req;
  req.destroy = () => {};
  req.end = () => {
    sent.push(JSON.parse(chunks.join('')));
    const res = new EventEmitter();
    res.statusCode = 204;
    res.resume = () => res;
    callback?.(res);
    setImmediate(() => res.emit('end'));
  };
  return req;
};
syncBuiltinESMExports();
delete process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY;

const { LOOKUPS_PER_FOLDER, validatePath } = await import('../dist/tools/filesystem.js');
const { capture, runWithToolCallPaths } = await import('../dist/utils/capture.js');

// More lookups in the stalled folder than run at a time there
const LOOKUPS_STARTED = 6;
// How long the test waits for telemetry, and for the folder to work again once its lookups answer
const DEADLINE_MS = 5_000;
// validatePath's time limit for one lookup (FILE_OPERATION_TIMEOUTS.PATH_VALIDATION in src/tools/filesystem.ts)
const LOOKUP_TIME_LIMIT_MS = 10_000;
// In the slow folder, each lookup answers after a bit more than a quarter of
// that limit. Four turns of LOOKUPS_PER_FOLDER lookups then take longer than
// the limit, so the last ones in line get their turn 7.8 seconds after they
// were made, while each lookup's own time on the disk stays far below 10 seconds
const SLOW_LOOKUP_MS = LOOKUP_TIME_LIMIT_MS / 4 + 100;
const SLOW_LOOKUPS = LOOKUPS_PER_FOLDER * 4;

/** Whether `p` is inside `folder`, at any depth, compared as the platform compares paths */
function isInside(p, folder) {
  const [a, b] = process.platform === 'win32' ? [p.toLowerCase(), folder.toLowerCase()] : [p, folder];
  return a.startsWith(b + path.sep);
}

/** Whether `a` and `b` are the same path, compared as the platform compares paths */
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * Makes fs.promises.realpath wait, for every path `stalls(path)` is true for,
 * until answer() is called; after that it answers as usual. `calls` lists the
 * paths it was asked for while it waited. restore() puts fs.promises.realpath back.
 */
function stallLookups(stalls) {
  const realpath = fsPromises.realpath;
  const waiting = [];
  const calls = [];
  let answered = false;
  fsPromises.realpath = function (p, ...rest) {
    if (answered || !stalls(path.resolve(String(p)))) {
      return realpath.call(this, p, ...rest);
    }
    calls.push(String(p));
    return new Promise((resolve) => waiting.push(resolve)).then(() => realpath.call(fsPromises, p, ...rest));
  };
  return {
    calls,
    answer: () => {
      answered = true;
      for (const resolve of waiting.splice(0)) resolve();
    },
    restore: () => {
      fsPromises.realpath = realpath;
    },
  };
}

/**
 * Makes fs.promises.realpath answer `ms` later for every path `slows(path)` is
 * true for, as a slow network share does. restore() puts back the
 * fs.promises.realpath it replaced.
 */
function slowLookups(slows, ms) {
  const realpath = fsPromises.realpath;
  fsPromises.realpath = function (p, ...rest) {
    if (!slows(path.resolve(String(p)))) {
      return realpath.call(this, p, ...rest);
    }
    return new Promise((resolve) => setTimeout(resolve, ms)).then(() => realpath.call(fsPromises, p, ...rest));
  };
  return {
    restore: () => {
      fsPromises.realpath = realpath;
    },
  };
}

/** validatePath's answer as { value } or { error }: it never rejects */
const settle = (p) => validatePath(p).then((value) => ({ value }), (error) => ({ error }));

const errorText = (answer) => (answer.error instanceof Error ? answer.error.message : String(answer.error ?? `answered ${answer.value}`));

/** Whether validatePath refused `p` because `folder` doesn't answer */
const failsFor = (answer, folder, p) => answer.error?.folder === folder && answer.error.message.includes(p);

/** The params of the events named `name` sent so far */
const sentEvents = (name) =>
  sent.flatMap((payload) => payload.events).filter((event) => event.name === name).map((event) => event.params);

/** How many server_path_validation_timeout events were sent so far */
const timeoutEvents = () => sentEvents('server_path_validation_timeout').length;

/** The error texts of the events the test sends after a lookup */
const afterLookupErrors = () => sentEvents('test_after_lookup').map((params) => params.error);

async function runTests() {
  if (!isTestHome()) {
    return skip('test-stalled-folder-lookups.js reads the config in the home; run it through the runner: node test/run-all-tests.js test-stalled-folder-lookups.js');
  }

  const root = createTempDir('dc-stalled-folder-');
  const stalled = path.join(root, 'stalled');
  const other = path.join(root, 'other');
  fs.mkdirSync(path.join(stalled, 'sub'), { recursive: true });
  fs.mkdirSync(other);
  const stalledFiles = Array.from({ length: LOOKUPS_STARTED }, (_, i) => path.join(stalled, `file-${i}.md`));
  for (const file of stalledFiles) fs.writeFileSync(file, 'stalled');
  const otherFile = path.join(other, 'other.md');
  fs.writeFileSync(otherFile, 'other');
  const slow = path.join(root, 'slow');
  fs.mkdirSync(slow);
  const slowFiles = Array.from({ length: SLOW_LOOKUPS }, (_, i) => path.join(slow, `file-${i}.md`));
  for (const file of slowFiles) fs.writeFileSync(file, 'slow');
  // A folder reached through a link, so a lookup there resolves to a path its
  // tool call doesn't know until the lookup tells it; the names have spaces,
  // which only a known path is replaced whole across
  const real = path.join(root, 'queued real');
  const linked = path.join(root, 'queued link');
  fs.mkdirSync(real);
  // 'junction' needs no admin rights on Windows; the type is ignored elsewhere
  fs.symlinkSync(real, linked, 'junction');
  const queuedFiles = Array.from({ length: LOOKUPS_STARTED }, (_, i) => path.join(linked, `file ${i}.md`));
  for (const file of queuedFiles) fs.writeFileSync(file, 'queued');
  // A folder where only one path hangs, beside a file that answers
  const oneHung = path.join(root, 'one hung');
  fs.mkdirSync(oneHung);
  const hungFile = path.join(oneHung, 'hung.md');
  const besideHung = path.join(oneHung, 'beside.md');
  fs.writeFileSync(besideHung, 'beside');
  // The root the temp folder is on (/ on macOS and Linux, a drive such as C:\
  // on Windows), so a path elsewhere on it exists. Folders directly in it that
  // don't exist stand for hung mount points: the lookups the test lets answer
  // find nothing
  const stalledRoot = path.parse(root).root;
  const hungMounts = Array.from({ length: LOOKUPS_PER_FOLDER }, (_, i) => path.join(stalledRoot, `dc-stalled-mount-${process.pid}-${i}`));

  let failures = 0;
  function check(name, ok, detail) {
    if (ok) {
      console.log(`✓ ${name}`);
    } else {
      failures++;
      console.error(`✗ ${name}: ${detail}`);
    }
  }

  // Installed first, so the stand-ins installed after it call it, and it is put back last
  const slowFolder = slowLookups((p) => isInside(p, slow), SLOW_LOOKUP_MS);
  const lookups = stallLookups((p) => samePath(p, stalled) || isInside(p, stalled));
  let oneHungLookups;
  let rootLookups;
  try {
    console.log(`\n--- ${LOOKUPS_STARTED} lookups at once in ${linked}, each in its own tool call ---`);
    // Each call then sends what a later error of its own would: text naming the path its lookup resolved to
    await Promise.all(queuedFiles.map((p) => runWithToolCallPaths(async () => {
      capture('test_after_lookup', { error: `Failed to read ${await validatePath(p)}` });
    })));
    await waitUntil(() => afterLookupErrors().length >= LOOKUPS_STARTED, DEADLINE_MS, 'the events are sent').catch(() => {});
    check('telemetry of a lookup that waited in line reads its own tool call\'s paths, so the path it resolved to is replaced whole',
      afterLookupErrors().length === LOOKUPS_STARTED && afterLookupErrors().every((error) => error === 'Failed to read [PATH]'),
      afterLookupErrors().join(' | '));

    console.log(`\n--- ${LOOKUPS_STARTED} lookups in ${stalled}, whose lookups don't answer; beside them, ${SLOW_LOOKUPS} in ${slow}, whose lookups answer after ${SLOW_LOOKUP_MS} ms ---`);
    // Side by side, so the slow folder's lookups add no time to the test
    const [answers, slowAnswers] = await Promise.all([Promise.all(stalledFiles.map(settle)), Promise.all(slowFiles.map(settle))]);
    const slowFailures = slowAnswers.filter((answer) => answer.error !== undefined);
    check(`every lookup in the slow folder answers, also the last ${LOOKUPS_PER_FOLDER}, which wait in line for ${3 * SLOW_LOOKUP_MS} ms`,
      slowAnswers.every((answer, i) => answer.value === slowFiles[i]),
      `${slowFailures.length} of ${SLOW_LOOKUPS} failed: ${slowFailures.map(errorText).join(' | ')}`);
    // Every lookup that reaches the disk has by now: the ones still in line failed with the others
    check(`only ${LOOKUPS_PER_FOLDER} of them reach the disk; the others wait in line`, lookups.calls.length === LOOKUPS_PER_FOLDER,
      `${lookups.calls.length} reached fs.promises.realpath`);
    check('a lookup that runs out of time fails with an error naming its own path, the one that hung',
      failsFor(answers[0], stalledFiles[0], stalledFiles[0]), errorText(answers[0]));
    check(`each of the ${LOOKUPS_PER_FOLDER} that ran out of time names its own path; once a second path in the folder hung, the lookups waiting in line fail with an error naming the folder`,
      answers.every((answer, i) => (i < LOOKUPS_PER_FOLDER
        ? failsFor(answer, stalledFiles[i], stalledFiles[i])
        : failsFor(answer, stalled, stalledFiles[i]))),
      answers.map(errorText).join(' | '));
    // Telemetry is sent in the background; the check below reports a timeout
    await waitUntil(() => timeoutEvents() >= LOOKUPS_PER_FOLDER, DEADLINE_MS, 'the timeouts are sent').catch(() => {});
    check('each lookup that ran out of time is sent to telemetry once', timeoutEvents() === LOOKUPS_PER_FOLDER,
      `${timeoutEvents()} server_path_validation_timeout events`);

    console.log('\n--- while those lookups still wait ---');
    const lookupsSoFar = lookups.calls.length;
    const newFile = path.join(stalled, 'new.md');
    const below = path.join(stalled, 'sub', 'below.md');
    const [inFolder, belowFolder, elsewhere] = await Promise.all([settle(newFile), settle(below), settle(otherFile)]);
    const noLookup = lookups.calls.length === lookupsSoFar;
    check('a path in the folder fails at once, without a lookup on the disk',
      noLookup && failsFor(inFolder, stalled, newFile),
      `${errorText(inFolder)} (${lookups.calls.length - lookupsSoFar} new lookups)`);
    check('a path below the folder fails at once, without a lookup on the disk',
      noLookup && failsFor(belowFolder, stalled, below),
      `${errorText(belowFolder)} (${lookups.calls.length - lookupsSoFar} new lookups)`);
    check('a path in another folder still works', elsewhere.value === otherFile, errorText(elsewhere));
    // After the others, so a lookup it makes counts against it alone
    const lookupsBefore = lookups.calls.length;
    const itself = await settle(stalled);
    check('the folder itself fails at once, without a lookup on the disk',
      lookups.calls.length === lookupsBefore && failsFor(itself, stalled, stalled),
      `${errorText(itself)} (${lookups.calls.length - lookupsBefore} new lookups)`);

    console.log('\n--- once the lookups answer ---');
    lookups.answer();
    let again;
    await waitUntil(async () => (again = await settle(stalledFiles[0])).value !== undefined, DEADLINE_MS, 'the folder works again').catch(() => {});
    check('the folder works again', again.value === stalledFiles[0], errorText(again));

    console.log(`\n--- ${hungMounts.length} lookups of folders in ${stalledRoot} that don't answer, as hung mount points don't, then ${LOOKUPS_STARTED} of the root itself; beside them, one of ${hungFile} ---`);
    oneHungLookups = stallLookups((p) => samePath(p, hungFile));
    // Only the root and what's directly in it: every other path the test uses is deeper
    rootLookups = stallLookups((p) => samePath(p, stalledRoot) || samePath(path.dirname(p), stalledRoot));
    // The root is in its own line too, so the lookups of it wait behind the others
    const rootPaths = [...hungMounts, ...Array(LOOKUPS_STARTED).fill(stalledRoot)];
    const [rootAnswers, oneHungAnswer] = await Promise.all([Promise.all(rootPaths.map(settle)), settle(hungFile)]);
    check(`only ${LOOKUPS_PER_FOLDER} lookups in the root reach the disk`, rootLookups.calls.length === LOOKUPS_PER_FOLDER,
      `${rootLookups.calls.length} reached fs.promises.realpath`);
    check('each folder in the root that ran out of time fails with an error naming that folder, not the root',
      hungMounts.every((mount, i) => failsFor(rootAnswers[i], mount, mount)),
      rootAnswers.slice(0, hungMounts.length).map(errorText).join(' | '));
    check('once every turn in the root\'s line is held by a lookup that ran out of time, the lookups of the root itself waiting in line fail at once',
      rootAnswers.slice(hungMounts.length).every((answer) => failsFor(answer, stalledRoot, stalledRoot)), errorText(rootAnswers.at(-1)));
    check('the one file that hung in its folder fails with an error naming that file, not its folder',
      failsFor(oneHungAnswer, hungFile, hungFile), errorText(oneHungAnswer));

    console.log('\n--- while those lookups still wait ---');
    const rootLookupsSoFar = rootLookups.calls.length;
    const inMount = path.join(hungMounts[0], 'file.md');
    const [elsewhereOnRoot, inMountAnswer, beside, hungAgain] = await Promise.all([settle(otherFile), settle(inMount), settle(besideHung), settle(hungFile)]);
    check(`the root isn't marked stalled: a path elsewhere on ${stalledRoot} still works`, elsewhereOnRoot.value === otherFile, errorText(elsewhereOnRoot));
    check('a path in a folder of the root that hung fails at once, without a lookup on the disk',
      rootLookups.calls.length === rootLookupsSoFar && failsFor(inMountAnswer, hungMounts[0], inMount),
      `${errorText(inMountAnswer)} (${rootLookups.calls.length - rootLookupsSoFar} new lookups)`);
    check('with only one path hung in a folder, the folder isn\'t marked stalled: the file beside it works',
      beside.value === besideHung, errorText(beside));
    check('the file that hung fails at once, without a lookup on the disk',
      oneHungLookups.calls.length === 1 && failsFor(hungAgain, hungFile, hungFile),
      `${errorText(hungAgain)} (${oneHungLookups.calls.length} lookups of it)`);
  } finally {
    // Put back in the order opposite to how they were installed
    rootLookups?.answer();
    rootLookups?.restore();
    oneHungLookups?.answer();
    oneHungLookups?.restore();
    lookups.answer();
    lookups.restore();
    slowFolder.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }

  if (failures > 0) {
    throw new Error(`${failures} stalled folder check(s) failed`);
  }
  console.log('\n✅ stalled folder lookups tests passed');
}

runIfMain(import.meta.url, runTests);

export default runTests;
