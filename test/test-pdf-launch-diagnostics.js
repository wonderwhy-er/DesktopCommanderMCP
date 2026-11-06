/** Controlled Chrome events must explain a failed launch without exposing its inputs or hiding its error. */
import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import { EventEmitter, errorMonitor } from 'node:events';
import fs from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { createChromeProfile } from '../dist/tools/pdf/markdown.js';
import { runIfMain } from './helpers/run-if-main.js';

const children = channel('child_process');
const SENTINEL = 'PRIVATE_PDF_INPUT_MUST_NOT_APPEAR';
const originalFailure = new Error('Timed out waiting for the browser endpoint');
originalFailure.name = 'TimeoutError';
const diagnosticPrefix = 'PDF browser launch diagnostic:';

/** No operating-system child or browser is started; only the real observer receives these events. */
function fakeChrome(profile) {
  const child = new EventEmitter();
  Object.assign(child, {
    spawnargs: [SENTINEL, profile.arg, `https://${SENTINEL}`, `--${SENTINEL}`],
    stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null,
  });
  children.publish({ process: child });
  return child;
}

/** The old profile supplies no launch wrapper; this control still preserves the actual rejected error. */
function launch(profile, start) {
  return profile.launch ? profile.launch(start) : start();
}

async function release(profile, child) {
  if (child) child.exitCode ??= 0;
  await profile.release();
  const directory = profile.arg.slice('--user-data-dir='.length);
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await fs.access(directory); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('The controlled profile should be removed after release');
}

function assertDetached(child) {
  for (const event of ['spawn', 'exit', 'error', errorMonitor]) {
    assert.equal(child.listenerCount(event), 0, 'The observer must remove its listeners');
  }
  assert.equal(child.stdout.listenerCount('data'), 0);
  assert.equal(child.stderr.listenerCount('data'), 0);
}

function readDiagnostic(captured) {
  assert.equal(captured.length, 1, 'One failed launch should emit one bounded diagnostic');
  assert.equal(captured[0][0], diagnosticPrefix);
  const snapshot = captured[0][1];
  assert.deepEqual(Object.keys(snapshot).sort(), [
    'child', 'elapsedMs', 'error', 'errorMs', 'exit', 'exitCode', 'exitMs',
    'failure', 'phase', 'signal', 'spawn', 'spawnMs', 'stderrBytes', 'stdoutBytes',
  ].sort());
  for (const value of Object.values(snapshot)) {
    assert(['string', 'number'].includes(typeof value), 'Only fixed enums and numbers may leave the observer');
    if (typeof value === 'number') assert(Number.isSafeInteger(value) && value >= -1);
  }
  assert(!JSON.stringify(captured).includes(SENTINEL), 'Private inputs and child streams must stay private');
  return snapshot;
}

async function timeoutKeepsOriginalFailure(captured) {
  const profile = await createChromeProfile();
  const child = fakeChrome(profile);
  child.emit('spawn'); // Node may announce spawn before the profile-matching microtask runs.
  try {
    await Promise.resolve();
    child.stdout.write(SENTINEL);
    child.stderr.write(SENTINEL.slice(0, 8));
    child.stderr.write(SENTINEL.slice(8));
    await assert.rejects(launch(profile, async () => { throw originalFailure; }), (error) => error === originalFailure);
    const snapshot = readDiagnostic(captured);
    assert.equal(snapshot.failure, 'timeout');
    assert.equal(snapshot.phase, 'before-owner-cleanup');
    assert.equal(snapshot.child, 'observed');
    assert.equal(snapshot.spawn, 'observed');
    assert.equal(snapshot.exit, 'unobserved');
    assert.equal(snapshot.stderrBytes, Buffer.byteLength(SENTINEL));
    assert.equal(snapshot.stdoutBytes, Buffer.byteLength(SENTINEL));
  } finally {
    await release(profile, child);
    assertDetached(child);
  }
}

async function errorsRemainErrors(captured) {
  const profile = await createChromeProfile();
  const child = fakeChrome(profile);
  const spawnFailure = Object.assign(new Error(SENTINEL), { code: 'EACCES' });
  try {
    // An errorMonitor listener may observe this error, but must not suppress EventEmitter's throw.
    assert.throws(() => child.emit('error', spawnFailure), (error) => error === spawnFailure);
    await Promise.resolve();
    await assert.rejects(launch(profile, async () => { throw spawnFailure; }), (error) => error === spawnFailure);
    const snapshot = readDiagnostic(captured);
    assert.equal(snapshot.error, 'EACCES');
    assert.equal(snapshot.spawn, 'unobserved');
    assert.equal(snapshot.failure, 'launch-error');
  } finally {
    await release(profile, child);
    assertDetached(child);
  }
}

async function concurrentProfilesStaySeparate(captured) {
  const left = await createChromeProfile();
  const right = await createChromeProfile();
  const leftChild = fakeChrome(left);
  const rightChild = fakeChrome(right);
  const unrelated = fakeChrome({ arg: `--user-data-dir=${SENTINEL}` });
  try {
    await Promise.resolve();
    assertDetached(unrelated);
    leftChild.emit('exit', 7, null);
    rightChild.emit('exit', 9, 'SIGTERM');
    await assert.rejects(launch(left, async () => { throw originalFailure; }), (error) => error === originalFailure);
    assert.equal(readDiagnostic(captured).exitCode, 7);
    captured.length = 0;
    await assert.rejects(launch(right, async () => { throw originalFailure; }), (error) => error === originalFailure);
    const snapshot = readDiagnostic(captured);
    assert.equal(snapshot.exitCode, 9);
    assert.equal(snapshot.signal, 'SIGTERM');
  } finally {
    await release(left, leftChild);
    await release(right, rightChild);
    assertDetached(leftChild);
    assertDetached(rightChild);
  }
}

async function successIsSilent(captured) {
  const profile = await createChromeProfile();
  const child = fakeChrome(profile);
  try {
    await Promise.resolve();
    child.emit('spawn');
    child.stderr.write(SENTINEL);
    const browser = {};
    assert.equal(await launch(profile, async () => browser), browser);
    assert.deepEqual(captured, [], 'A successful launch must not emit diagnostics');
  } finally {
    await release(profile, child);
    assertDetached(child);
  }
}

async function absentChildIsExplicit(captured) {
  const profile = await createChromeProfile();
  try {
    await assert.rejects(launch(profile, async () => { throw originalFailure; }), (error) => error === originalFailure);
    const snapshot = readDiagnostic(captured);
    assert.equal(snapshot.child, 'unobserved');
    assert.equal(snapshot.error, 'none');
  } finally {
    await release(profile);
  }
}

async function diagnosticSinkCannotReplaceFailure() {
  const profile = await createChromeProfile();
  const previous = console.error;
  console.error = () => { throw new Error(SENTINEL); };
  try {
    await assert.rejects(launch(profile, async () => { throw originalFailure; }), (error) => error === originalFailure);
  } finally {
    console.error = previous;
    await release(profile);
  }
}

export default async function runTests() {
  const captured = [];
  const previous = console.error;
  const failures = [];
  console.error = (...arguments_) => captured.push(arguments_);
  try {
    for (const check of [timeoutKeepsOriginalFailure, errorsRemainErrors, concurrentProfilesStaySeparate,
      successIsSilent, absentChildIsExplicit, diagnosticSinkCannotReplaceFailure]) {
      captured.length = 0;
      try { await check(captured); console.log(`PASS ${check.name}`); }
      catch (error) { failures.push(check.name); console.log(`FAIL ${check.name}: ${error.message}`); }
    }
  } finally {
    console.error = previous;
  }
  assert.deepEqual(failures, [], 'Controlled launch diagnostics must preserve failures, privacy and cleanup');
  return true;
}

runIfMain(import.meta.url, runTests);
