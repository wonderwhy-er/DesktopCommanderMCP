/**
 * A check skipped because this machine lacks something (Python, file symlinks)
 * must be reported as skipped, not passed. skip() recorded it for the runner's
 * summary, but a file's own summary counted it as passed: the REPL test printed
 * "Python REPL test: PASSED" and "ALL TESTS PASSED" without Python, and the
 * symlink test "Results: 7 passed" with its Test 4 skipped.
 *
 * Runs those test files as the runner does, each with its own skip record:
 * - test-repl-interaction.js with Python hidden (PATH: node's folder and system
 *   folders only);
 * - test-symlink-security.js where its Test 4 skips (Windows without Developer
 *   Mode); elsewhere that case is skipped here.
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { runIfMain, skip, SKIPPED } from './helpers/run-if-main.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const plain = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');

/** Runs a test file the way run-all-tests.js does, with its own skip record and `pathDirs` as PATH if given */
function runTestFile(file, pathDirs) {
  const skipFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-skip-reporting-')), 'skips.txt');
  const env = { ...process.env, DC_TEST_SKIP_FILE: skipFile };
  if (pathDirs) {
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
    env.PATH = pathDirs.join(path.delimiter);
  }
  const result = spawnSync(process.execPath, [file], { cwd: TEST_DIR, env, encoding: 'utf8', timeout: 180_000 });
  const skips = fs.existsSync(skipFile) ? fs.readFileSync(skipFile, 'utf8') : '';
  fs.rmSync(path.dirname(skipFile), { recursive: true, force: true });
  return { output: plain(`${result.stdout}${result.stderr}`), status: result.status, skips };
}

/** node's own folder plus the system folders, none of which holds Python */
function pathWithoutPython() {
  const nodeDir = path.dirname(process.execPath);
  if (process.platform === 'win32') {
    const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    return [nodeDir, system32, path.join(system32, 'WindowsPowerShell', 'v1.0')];
  }
  return [nodeDir, '/bin', '/usr/sbin', '/sbin'];
}

async function replTestWithoutPython() {
  const { output, skips } = runTestFile('./test-repl-interaction.js', pathWithoutPython());
  if (!output.includes('SKIPPED: Python REPL interaction test')) {
    return skip(`REPL summary: Python was still found with PATH ${pathWithoutPython().join(path.delimiter)}`);
  }
  assert(skips.includes('Python REPL interaction test'), 'the Python skip was not recorded for the runner');
  const line = output.split('\n').find((text) => text.startsWith('Python REPL test:')) ?? '(no summary line)';
  assert.strictEqual(line.trim(), 'Python REPL test: SKIPPED', `without Python the REPL test's summary said "${line.trim()}"`);
  assert(!output.includes('ALL TESTS PASSED'), 'without Python the REPL test said "ALL TESTS PASSED"');
}

async function symlinkTestWithTest4Skipped() {
  const { output, status } = runTestFile('./test-symlink-security.js');
  if (!output.includes('SKIPPED: Test 4')) {
    return skip('symlink summary: file symlinks can be created here, so its Test 4 runs');
  }
  const line = output.split('\n').find((text) => text.startsWith('Results:')) ?? '(no results line)';
  assert.strictEqual(line.trim(), 'Results: 6 passed, 0 failed, 1 skipped', `with Test 4 skipped the symlink test said "${line.trim()}"`);
  assert.strictEqual(status, 0, 'a skipped check must not fail the file');
}

export default async function runTests() {
  const failures = [];
  for (const check of [replTestWithoutPython, symlinkTestWithTest4Skipped]) {
    try {
      console.log(`${await check() === SKIPPED ? '- skipped:' : '✓'} ${check.name}`);
    } catch (error) {
      failures.push(check.name);
      console.log(`✗ ${check.name}: ${error.message}`);
    }
  }
  return failures.length === 0;
}

runIfMain(import.meta.url, runTests);
