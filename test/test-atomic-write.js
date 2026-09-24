/**
 * writeFileAtomic (src/utils/atomic-write.ts) is the one crash-safe write for
 * config.json, device.json (the device's login) and the feature-flag cache.
 * Its promise: after a crash or power loss the file holds the previous or the
 * new content, never an empty or zero-filled one (#697, #692). A rename alone
 * doesn't keep it: the new name can reach the disk before the data. So the
 * data must be flushed (fsync) before the rename, and on macOS/Linux the
 * folder after it, so the rename itself survives.
 *
 * Checks the order of what reaches the disk, in-process: fs/promises' open and
 * rename are wrapped to record each flush and rename.
 */
import assert from 'assert';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { writeFileAtomic } from '../dist/utils/atomic-write.js';
import { runIfMain } from './helpers/run-if-main.js';

/** Runs `write` with open/rename recorded: 'sync <path>' and 'rename <from> -> <to>', in order */
async function recordDiskOrder(write) {
  const events = [];
  const { open, rename } = fsp;
  fsp.open = async (file, ...rest) => {
    const handle = await open(file, ...rest);
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      await sync();
      events.push(`sync ${file}`);
    };
    return handle;
  };
  fsp.rename = async (from, to) => {
    await rename(from, to);
    events.push(`rename ${from} -> ${to}`);
  };
  try {
    await write();
  } finally {
    fsp.open = open;
    fsp.rename = rename;
  }
  return events;
}

async function testFlushedBeforeRename() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-atomic-write-')));
  const target = path.join(dir, 'config.json');
  try {
    fs.writeFileSync(target, '{"old":true}');
    const events = await recordDiskOrder(() => writeFileAtomic(target, '{"new":true}'));
    assert.strictEqual(fs.readFileSync(target, 'utf8'), '{"new":true}', 'the file should hold the new content');

    const renameAt = events.findIndex((event) => event.startsWith('rename ') && event.endsWith(` -> ${target}`));
    assert(renameAt >= 0, `the new content should be renamed into place, events: ${JSON.stringify(events)}`);
    const tempPath = events[renameAt].slice('rename '.length, events[renameAt].indexOf(' -> '));
    assert(events.slice(0, renameAt).includes(`sync ${tempPath}`),
      `the data should reach the disk before the rename, events: ${JSON.stringify(events)}`);
    if (process.platform !== 'win32') {
      assert(events.slice(renameAt + 1).includes(`sync ${dir}`),
        `the rename should reach the disk (folder flushed after it), events: ${JSON.stringify(events)}`);
    }
    console.log('✓ the data is flushed before the rename, and on macOS/Linux the folder after it');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export default async function runTests() {
  await testFlushedBeforeRename();
  return true;
}

runIfMain(import.meta.url, runTests);
