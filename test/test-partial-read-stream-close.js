import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { TextFileHandler } from '../dist/utils/files/text.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-partial-read-'));
const target = path.join(dir, 'target.txt');
const replacement = path.join(dir, 'replacement.txt');

try {
  const lines = Array.from({ length: 512 }, (_, i) => `line-${i + 1} ${'x'.repeat(480)}`);
  await fs.writeFile(target, lines.join('\n'), 'utf8');

  const handler = new TextFileHandler();
  const result = await handler.read(target, {
    offset: 0,
    length: 5,
    includeStatusMessage: false,
  });

  const returned = result.content.split('\n');
  if (returned.length !== 5 || returned[0] !== lines[0]) {
    throw new Error(`Expected first 5 lines, got ${returned.length}`);
  }

  await fs.writeFile(replacement, 'replacement\n', 'utf8');
  await fs.rename(replacement, target);

  const replaced = await fs.readFile(target, 'utf8');
  if (replaced !== 'replacement\n') {
    throw new Error('Replacement content mismatch');
  }

  console.log('Partial read releases the target before replacement');
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
