/**
 * Tests for searchFiles() (src/tools/filesystem.ts): a file-name search run to
 * completion, returning every matching path exactly once.
 */

import assert from 'assert';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { searchFiles } from '../dist/tools/filesystem.js';
import { searchManager } from '../dist/search-manager.js';
import { configManager } from '../dist/config-manager.js';
import { runIfMain } from './helpers/run-if-main.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, 'search-files-test');

// Well past one page of search results (readSearchResults returns 100 by default)
const MATCHING_FILES = 250;

/**
 * searchFiles() must return all matching files, each once - not the first page
 * of results again on every poll
 */
async function testReturnsEveryMatchOnce() {
  console.log('Testing that searchFiles returns every matching file exactly once...');

  const names = Array.from({ length: MATCHING_FILES }, (_, i) => `item-${String(i).padStart(3, '0')}.txt`);
  await Promise.all(names.map((name) => fs.writeFile(path.join(TEST_DIR, name), 'content')));
  await fs.writeFile(path.join(TEST_DIR, 'unrelated.txt'), 'content');

  const found = await searchFiles(TEST_DIR, 'item');

  // Search results carry the validated (real) path of the search root
  const root = await fs.realpath(TEST_DIR);
  const expected = names.map((name) => path.join(root, name));
  assert.strictEqual(found.length, MATCHING_FILES, `Expected ${MATCHING_FILES} paths, got ${found.length}`);
  assert.deepStrictEqual([...found].sort(), expected, 'searchFiles should return each matching file exactly once');

  console.log(`✓ ${found.length} matching files returned, no duplicates`);
}

export default async function runTests() {
  const originalConfig = await configManager.getConfig();
  await fs.rm(TEST_DIR, { recursive: true, force: true });
  await fs.mkdir(TEST_DIR, { recursive: true });
  await configManager.setValue('allowedDirectories', [TEST_DIR]);
  try {
    await testReturnsEveryMatchOnce();
    console.log('✅ searchFiles tests passed');
  } finally {
    // Stop any search still running (before its files are removed) and drop all sessions
    searchManager.dispose();
    await configManager.updateConfig(originalConfig);
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  }
}

runIfMain(import.meta.url, runTests);
