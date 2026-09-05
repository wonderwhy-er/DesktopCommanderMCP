import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFile } from '../dist/tools/filesystem.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-commander-read-release-'));
const target = path.join(dir, 'target.txt');
const replacement = path.join(dir, 'replacement.txt');

try {
  await fs.writeFile(target, 'one\ntwo\nthree\nfour\nfive\n');
  await readFile(target, { offset: 0, length: 5 });
  await fs.writeFile(replacement, 'replacement\n');

  await fs.rename(replacement, target);

  assert.equal(await fs.readFile(target, 'utf8'), 'replacement\n');
  console.log('read_file releases its stream before returning');
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
