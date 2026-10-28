/**
 * A folder whose lookups stop answering (a network share that hangs) must not
 * hold up other folders, and must work again once it answers.
 *
 * validatePath() (src/tools/filesystem.ts) looks every path up on the disk
 * with fs.promises.realpath before a file operation. Here that lookup waits,
 * for every path in one folder, until the test lets it answer. Expected:
 *   - at most LOOKUPS_PER_FOLDER lookups in that folder run at a time; the
 *     others wait in line
 *   - a lookup that waited in line still runs in its own tool call: what that
 *     call sends to telemetry afterwards has the path it resolved to replaced
 *     whole
 *   - a lookup that waits more than 10 seconds fails with an error that names
 *     the folder and the path, instead of "__ERROR__: Path validation
 *     operation timed out after 10 seconds", and is sent to telemetry once,
 *     as server_path_validation_timeout
 *   - while that lookup still waits, a path in the folder or below it fails at
 *     once with the same error, without a lookup on the disk
 *   - a path in another folder still works
 *   - once the waiting lookups answer, the folder works again
 *
 * Telemetry is caught the way test-telemetry-paths.js catches it. Takes about
 * 10 seconds: a lookup's own time limit. Runs as part of `npm test`, or alone:
 * node test/run-all-tests.js test-stalled-folder-lookups.js
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

/** Whether `p` is inside `folder`, at any depth, compared as the platform compares paths */
function isInside(p, folder) {
  const [a, b] = process.platform === 'win32' ? [p.toLowerCase(), folder.toLowerCase()] : [p, folder];
  return a.startsWith(b + path.sep);
}

/**
 * Makes fs.promises.realpath wait, for every path inside `folder`, until
 * answer() is called; after that it answers as usual. `calls` lists the paths
 * it was asked for while it waited. restore() puts fs.promises.realpath back.
 */
function stallLookups(folder) {
  const realpath = fsPromises.realpath;
  const waiting = [];
  const calls = [];
  let answered = false;
  fsPromises.realpath = function (p, ...rest) {
    if (answered || !isInside(path.resolve(String(p)), folder)) {
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

  let failures = 0;
  function check(name, ok, detail) {
    if (ok) {
      console.log(`✓ ${name}`);
    } else {
      failures++;
      console.error(`✗ ${name}: ${detail}`);
    }
  }

  const lookups = stallLookups(stalled);
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

    console.log(`\n--- ${LOOKUPS_STARTED} lookups in ${stalled}, whose lookups don't answer ---`);
    const answers = await Promise.all(stalledFiles.map(settle));
    // Every lookup that reaches the disk has by now: the ones still in line failed with the others
    check(`only ${LOOKUPS_PER_FOLDER} of them reach the disk; the others wait in line`, lookups.calls.length === LOOKUPS_PER_FOLDER,
      `${lookups.calls.length} reached fs.promises.realpath`);
    check('a lookup that waits more than 10 seconds fails with an error naming the folder and the path',
      failsFor(answers[0], stalled, stalledFiles[0]), errorText(answers[0]));
    check('the lookups waiting in line fail with that error too',
      answers.every((answer, i) => failsFor(answer, stalled, stalledFiles[i])), answers.map(errorText).join(' | '));
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

    console.log('\n--- once the lookups answer ---');
    lookups.answer();
    let again;
    await waitUntil(async () => (again = await settle(stalledFiles[0])).value !== undefined, DEADLINE_MS, 'the folder works again').catch(() => {});
    check('the folder works again', again.value === stalledFiles[0], errorText(again));
  } finally {
    lookups.answer();
    lookups.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }

  if (failures > 0) {
    throw new Error(`${failures} stalled folder check(s) failed`);
  }
  console.log('\n✅ stalled folder lookups tests passed');
}

runIfMain(import.meta.url, runTests);

export default runTests;
