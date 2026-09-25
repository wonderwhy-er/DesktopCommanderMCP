import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFile } from '../dist/tools/filesystem.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-commander-large-read-release-'));
const target = path.join(dir, 'target.txt');
const replacement = path.join(dir, 'replacement.txt');

try {
  const line = `${'x'.repeat(127)}\n`;
  await fs.writeFile(target, line.repeat(90000));
  await readFile(target, { offset: 2000, length: 5 });
  await fs.writeFile(replacement, 'replacement\n');

  await fs.rename(replacement, target);

  assert.equal(await fs.readFile(target, 'utf8'), 'replacement\n');
  console.log('large read_file releases sampling and result streams before returning');
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
