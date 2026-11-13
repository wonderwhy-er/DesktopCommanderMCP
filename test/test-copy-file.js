/**
 * copy_file (#676): copying is not moving, never overwrites an existing
 * destination, and uses the same allowed-path validation as other file tools.
 * This suite runs in an isolated test home via test/run-all-tests.js.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as fileHandlers from '../dist/handlers/filesystem-handlers.js';
import { toolArgSchemas } from '../dist/tools/schemas.js';
import { createTempDir, isTestHome } from './helpers/test-env.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

const answer = (result) => result.content.map((part) => part.text ?? '').join('\n');

export default async function runTests() {
  assert.ok(toolArgSchemas.copy_file, 'copy_file must have a registered argument schema');
  assert.equal(typeof fileHandlers.handleCopyFile, 'function', 'copy_file must expose a handler');

  if (!isTestHome()) {
    skip('copy_file filesystem tests need isolated HOME; run with test/run-all-tests.js');
    return true;
  }

  const dir = createTempDir('dc-copy-file-');
  try {
    const source = path.join(dir, 'source.bin');
    const dest = path.join(dir, 'target.bin');
    const bytes = Buffer.from([0, 255, 12, 13, 42, 128]);
    await fs.writeFile(source, bytes);

    const copied = await fileHandlers.handleCopyFile({ source, destination: dest });
    assert.equal(copied.isError, undefined, answer(copied));
    assert.match(answer(copied), /Successfully copied/);
    assert.deepEqual(await fs.readFile(source), bytes, 'copy_file must preserve source bytes');
    assert.deepEqual(await fs.readFile(dest), bytes, 'copy_file must preserve binary bytes');
    console.log('ok - copies bytes without removing the original file');

    const existing = Buffer.from('keep existing');
    await fs.writeFile(dest, existing);
    const rejected = await fileHandlers.handleCopyFile({ source, destination: dest });
    assert.equal(rejected.isError, true, 'existing destination must be rejected');
    assert.deepEqual(await fs.readFile(dest), existing, 'existing destination must not be overwritten');
    assert.deepEqual(await fs.readFile(source), bytes);
    console.log('ok - existing destination remains intact');

    const absent = await fileHandlers.handleCopyFile({
      source: path.join(dir, 'missing.bin'),
      destination: path.join(dir, 'not-created.bin'),
    });
    assert.equal(absent.isError, true);
    await assert.rejects(fs.stat(path.join(dir, 'not-created.bin')), { code: 'ENOENT' });
    console.log('ok - missing source does not create destination');

    const folder = path.join(dir, 'folder');
    await fs.mkdir(folder);
    const directoryCopy = await fileHandlers.handleCopyFile({
      source: folder,
      destination: path.join(dir, 'folder-copied'),
    });
    assert.equal(directoryCopy.isError, true, 'copy_file must not silently copy a directory');
    await assert.rejects(fs.stat(path.join(dir, 'folder-copied')), { code: 'ENOENT' });
    console.log('ok - directories require an explicit different operation');
    return true;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

runIfMain(import.meta.url, runTests);
