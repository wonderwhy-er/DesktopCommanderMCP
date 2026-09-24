/**
 * move_file and the tool-call log rotation while another process holds the
 * file open.
 *
 * On Windows a file another process has open (antivirus, indexers, readers)
 * can't be renamed until it lets go: the rename fails with EPERM/EBUSY. Both
 * operations must wait that out instead of failing. On macOS/Linux an open
 * file never blocks a rename, so there this only checks the operations work.
 * A rename that can never succeed (onto an existing folder, which Windows also
 * answers with EPERM) must fail at once instead of waiting out the retries.
 */

import assert from 'assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { moveFile } from '../dist/tools/filesystem.js';
import { trackToolCall } from '../dist/utils/trackTools.js';
import { TOOL_CALL_FILE, TOOL_CALL_FILE_MAX_SIZE } from '../dist/config.js';
import { holdFileOpen } from './helpers/hold-file-open.js';
import { runIfMain, skip } from './helpers/run-if-main.js';
import { isTestHome } from './helpers/test-env.js';

const LOCK_MS = 1000;

async function testMoveFileWhileHeldOpen(dir) {
  console.log('\nTest 1: move_file on a file another process holds open');

  const source = path.join(dir, 'held.txt');
  const destination = path.join(dir, 'moved.txt');
  await fs.writeFile(source, 'held content');

  const holder = await holdFileOpen(source, LOCK_MS);
  try {
    await moveFile(source, destination);
  } finally {
    holder.kill();
  }

  assert.strictEqual(await fs.readFile(destination, 'utf8'), 'held content', 'move_file should move the file once the other process lets go');
  console.log('✓ Test 1 passed: move_file waited for the other process to let go');
}

async function testLogRotationWhileHeldOpen() {
  console.log('\nTest 2: tool-call log rotation while another process holds the log open');

  const logDir = path.dirname(TOOL_CALL_FILE);
  const logBase = path.basename(TOOL_CALL_FILE, path.extname(TOOL_CALL_FILE));
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(TOOL_CALL_FILE, 'x'.repeat(TOOL_CALL_FILE_MAX_SIZE));

  const holder = await holdFileOpen(TOOL_CALL_FILE, LOCK_MS);
  try {
    await trackToolCall('rotation_test');
  } finally {
    holder.kill();
  }

  const rotated = (await fs.readdir(logDir)).filter((file) => file.startsWith(`${logBase}_`));
  assert.strictEqual(rotated.length, 1, `the full log should have been rotated, rotated files: ${rotated.join(', ') || 'none'}`);
  const current = await fs.readFile(TOOL_CALL_FILE, 'utf8');
  assert.ok(current.includes('rotation_test') && current.length < TOOL_CALL_FILE_MAX_SIZE,
    'the call should be logged in a new, small log file');
  console.log('✓ Test 2 passed: the log was rotated once the other process let go');
}

async function testMoveOntoFolderFailsAtOnce(dir) {
  console.log('\nTest 3: move_file onto an existing folder fails at once');

  const folder = path.join(dir, 'full');
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'keep.txt'), 'keep');
  const source = path.join(dir, 'a.txt');
  await fs.writeFile(source, 'a');

  const started = Date.now();
  await assert.rejects(moveFile(source, folder));
  const elapsed = Date.now() - started;
  // The retries last up to 5 s; failing at once takes milliseconds (×10 margin)
  assert.ok(elapsed < 500, `move_file onto an existing folder can never succeed, but it failed only after ${elapsed}ms of retries`);
  assert.strictEqual(await fs.readFile(source, 'utf8'), 'a', 'the source should be left as it was');
  console.log(`✓ Test 3 passed: failed after ${elapsed}ms`);
}

export default async function runTests() {
  // Test 2 replaces the tool-call log, so never run this in a real home
  if (!isTestHome()) {
    skip('test-rename-held-file.js replaces the tool-call log; run it through the runner: node test/run-all-tests.js test-rename-held-file.js');
    return true;
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-rename-held-'));
  let failed = 0;
  for (const test of [() => testMoveFileWhileHeldOpen(dir), testLogRotationWhileHeldOpen, () => testMoveOntoFolderFailsAtOnce(dir)]) {
    try {
      await test();
    } catch (error) {
      failed++;
      console.error('❌ Test failed:', error.message);
    }
  }
  await fs.rm(dir, { recursive: true, force: true });
  if (failed === 0) console.log('\n✅ All held-file rename tests passed!');
  return failed === 0;
}

runIfMain(import.meta.url, runTests);
