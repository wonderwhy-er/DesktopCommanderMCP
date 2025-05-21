import { readFile } from '../dist/tools/filesystem.js';
import { configManager } from '../dist/config-manager.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_FILE = path.join(__dirname, 'offset-test.txt');
const TOTAL_LINES = 800;
const OFFSET = 1000;
const LENGTH = 100;

async function setup() {
  await configManager.setValue('allowedDirectories', [__dirname]);
  const lines = Array.from({length: TOTAL_LINES}, (_, i) => `line ${i + 1}`).join('\n');
  await fs.writeFile(TEST_FILE, lines);
}

async function teardown() {
  await fs.rm(TEST_FILE, { force: true });
}

async function testReadFileOffset() {
  await setup();
  try {
    const result = await readFile(TEST_FILE, false, OFFSET, LENGTH);
    const content = typeof result === 'string' ? result : result.content;
    const lines = content.split('\n').slice(-LENGTH); // last LENGTH lines of output
    for (let i = 0; i < LENGTH; i++) {
      const expected = `line ${TOTAL_LINES - LENGTH + 1 + i}`;
      if (lines[i].trim() !== expected) {
        throw new Error(`Expected ${expected} but got ${lines[i]}`);
      }
    }
    if (!content.includes('Offset beyond file')) {
      throw new Error('Expected offset beyond file message');
    }
    return true;
  } finally {
    await teardown();
  }
}

export default testReadFileOffset;
