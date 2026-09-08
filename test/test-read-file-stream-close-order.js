import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFile, readMultipleFiles } from '../dist/tools/filesystem.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-commander-read-close-order-'));

async function assertReadAwaitsStreamClose(label, operation) {
  const originalDestroy = fsSync.ReadStream.prototype._destroy;
  let pendingCloses = 0;
  let completedCloses = 0;

  fsSync.ReadStream.prototype._destroy = function delayedDestroy(error, callback) {
    pendingCloses += 1;
    setTimeout(() => {
      originalDestroy.call(this, error, (...args) => {
        pendingCloses -= 1;
        completedCloses += 1;
        callback(...args);
      });
    }, 75);
  };

  try {
    await operation();
    assert.equal(
      pendingCloses,
      0,
      `${label} returned before its ReadStream close completed`,
    );
    assert.ok(completedCloses > 0, `${label} did not exercise a ReadStream close`);
  } finally {
    fsSync.ReadStream.prototype._destroy = originalDestroy;
    if (pendingCloses > 0) {
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }
}

try {
  const defaultTarget = path.join(dir, 'default.txt');
  await fs.writeFile(defaultTarget, 'line\n'.repeat(2000));
  await assertReadAwaitsStreamClose('default-budget readFile', () => readFile(defaultTarget));

  const largeTarget = path.join(dir, 'large.txt');
  const largeLine = `${'x'.repeat(127)}\n`;
  await fs.writeFile(largeTarget, largeLine.repeat(90000));
  await assertReadAwaitsStreamClose('large estimated-position readFile', () =>
    readFile(largeTarget, { offset: 2000, length: 5 }),
  );

  const multiA = path.join(dir, 'multi-a.txt');
  const multiB = path.join(dir, 'multi-b.txt');
  await Promise.all([
    fs.writeFile(multiA, 'a\n'.repeat(2000)),
    fs.writeFile(multiB, 'b\n'.repeat(2000)),
  ]);
  await assertReadAwaitsStreamClose('readMultipleFiles', () =>
    readMultipleFiles([multiA, multiB]),
  );

  console.log('read paths await ReadStream closure before resolving');
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
