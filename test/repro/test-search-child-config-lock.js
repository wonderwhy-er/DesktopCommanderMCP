// Repro (#768): in a full test run, test-search-without-ripgrep.js took 60.8 s
// and failed (its child was killed at 60 s), then its process died of
// ECOMPROMISED ("Unable to update lock within the stale threshold"). The test
// searches in-process first, and every search's telemetry capture starts a
// locked config write (the client id), fire-and-forget. It then started its
// child with spawnSync, which froze the test process while one of those writes
// held the config lock: the child's own config writes waited on it until it went
// stale (30 s), and when spawnSync returned the test process found its lock
// taken over and died. test-search-office-completion.js starts its child the
// same way.
//
// Here each of the two tests runs, in a home of its own, with a preload
// (fixtures/config-lock-at-child-spawn.mjs) that takes the config lock whenever
// the test starts a Node.js child and releases it 200 ms later on a timer, so
// the lock is held at that moment every run.
//
// Run: node test/repro/run-repro.js test-search-child-config-lock.js
// Exit code: 1 if a test is held up by the lock (25 s or more), dies of
// ECOMPROMISED, or fails.
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createTestEnv } from '../helpers/test-env.js';
import { exitProcess } from '../../dist/utils/exit-process.js';

const TEST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRELOAD = pathToFileURL(path.join(TEST_DIR, 'fixtures', 'config-lock-at-child-spawn.mjs')).href;
const TESTS = ['test-search-without-ripgrep.js', 'test-search-office-completion.js'];
// The lock goes stale after 30 s; without the hold-up each test takes a few seconds
const HELD_UP_MS = 25_000;
const TIME_LIMIT_MS = 120_000;

function runTest(file) {
  return new Promise((resolve) => {
    const testEnv = createTestEnv();
    const startedAt = Date.now();
    const child = spawn(process.execPath, ['--import', PRELOAD, file], { cwd: TEST_DIR, env: testEnv.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const limit = setTimeout(() => child.kill(), TIME_LIMIT_MS);
    child.on('close', (status, signal) => {
      clearTimeout(limit);
      testEnv.cleanup();
      resolve({ file, ms: Date.now() - startedAt, status, signal, output });
    });
  });
}

let problems = 0;
for (const file of TESTS) {
  const run = await runTest(file);
  const lockHeld = run.output.includes('[config-lock-at-child-spawn] holding the config lock');
  const heldUp = run.ms >= HELD_UP_MS;
  const compromised = /ECOMPROMISED|Unable to update lock/.test(run.output);
  const failed = run.status !== 0;
  if (heldUp || compromised || failed) problems++;
  console.log(`${file}: ${run.ms} ms, exit ${run.status}${run.signal ? ` (${run.signal})` : ''}; ` +
    `lock held when its child started: ${lockHeld}${heldUp ? '; held up by the lock' : ''}${compromised ? '; died of ECOMPROMISED' : ''}`);
  if (heldUp || compromised || failed) {
    const lines = run.output.split('\n').filter((line) => /ECOMPROMISED|Unable to update lock|failed|Error|❌/.test(line));
    for (const line of lines.slice(0, 5)) console.log(`   ${line.trim().slice(0, 200)}`);
  }
}

console.log(problems > 0
  ? `REPRODUCED: ${problems} of ${TESTS.length} tests were held up by the config lock their process held when it started its child, or failed`
  : `NOT REPRODUCED: both tests started their child while their process held the config lock and finished in seconds`);
exitProcess(problems > 0 ? 1 : 0);
