/**
 * Test that renames survive a file being briefly held open by another process.
 *
 * On Windows, a process holding a file open without delete sharing (antivirus,
 * indexers, other readers) blocks renaming it with EPERM/EBUSY until it lets
 * go; renameWithRetry must wait that out. On macOS/Linux an open file never
 * blocks a rename, so the same test just checks the move itself.
 */

import assert from 'assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { renameWithRetry } from '../dist/utils/rename.js';
import { holdFileOpen } from './helpers/hold-file-open.js';
import { runIfMain } from './helpers/run-if-main.js';

const isWindows = process.platform === 'win32';
// The holder keeps the file open until the test kills it (long past any run),
// so the test, not a timer in the holder, decides when it lets go
const HOLD_MS = 60_000;
// renameWithRetry retries for up to 5 s (rename.ts). The holder lets go this
// long after it starts, so the retries must wait that out, with the rest of
// the 5 s to spare on a loaded machine
const RELEASE_AFTER_MS = 300;
// The retries last up to 5 s; failing at once takes milliseconds. Half the
// retry budget still tells the two apart on a loaded machine
const FAIL_AT_ONCE_MS = 2500;

async function testRenameWhileHeldOpen(dir) {
  console.log('\nTest 1: Rename a file another process holds open');

  const source = path.join(dir, 'held.txt');
  const destination = path.join(dir, 'moved.txt');
  await fs.writeFile(source, 'held content');

  const holder = await holdFileOpen(source, HOLD_MS);
  try {
    if (isWindows) {
      // The lock is real: a plain rename fails while the file is held open
      await assert.rejects(fs.rename(source, destination),
        (error) => ['EPERM', 'EBUSY', 'EACCES'].includes(error.code),
        'Plain fs.rename should fail while another process holds the file');
      console.log('✓ Plain fs.rename is blocked while the file is held open');
    }

    const started = Date.now();
    // Let go while renameWithRetry is retrying: it must wait that out
    const release = setTimeout(() => holder.kill(), RELEASE_AFTER_MS);
    try {
      await renameWithRetry(source, destination);
    } finally {
      clearTimeout(release);
    }
    console.log(`✓ renameWithRetry succeeded after ${Date.now() - started}ms`);
  } finally {
    holder.kill();
  }

  assert.strictEqual(await fs.readFile(destination, 'utf8'), 'held content', 'Moved file should keep its content');
  await assert.rejects(fs.access(source), 'Source should no longer exist');
  console.log('✓ Test 1 passed: file moved once the other process let go');
}

async function testPermanentErrorsAreNotRetried(dir) {
  console.log('\nTest 2: Permanent errors fail immediately');

  const started = Date.now();
  await assert.rejects(renameWithRetry(path.join(dir, 'missing.txt'), path.join(dir, 'x.txt')),
    (error) => error.code === 'ENOENT');
  const elapsed = Date.now() - started;
  assert.ok(elapsed < FAIL_AT_ONCE_MS, `A missing source should fail without retrying, took ${elapsed}ms`);

  console.log('✓ Test 2 passed: ENOENT is thrown without retrying');
}

export default async function runTests() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-rename-'));
  try {
    await testRenameWhileHeldOpen(dir);
    await testPermanentErrorsAreNotRetried(dir);
    console.log('\n✅ All rename tests passed!');
    return true;
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    return false;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

runIfMain(import.meta.url, runTests);
