/**
 * A file search's filePattern limits the files it finds: start_search with
 * searchType "files" returns the files whose name matches the pattern AND that
 * the filePattern selects ("Optional filter to limit search to specific file
 * types"). It returned every file that either one matched: pattern "auth" with
 * filePattern "*.ts" also returned auth.md, and "!*.md" still returned it.
 * ripgrep got both as globs of one list, where any glob lets a file in and the
 * last matching glob wins over a "!".
 * filePattern means what it means for a content search's text files: ripgrep's
 * globs, "|"-separated, "!" to leave files out, a "/" to match the path below
 * the search path; for file names, ignoreCase applies (as it does to the pattern).
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { searchManager } from '../dist/search-manager.js';
import { configManager } from '../dist/config-manager.js';
import { searchUntilDone, filesInAnswer } from './helpers/search.js';
import { runIfMain } from './helpers/run-if-main.js';

const FILES = ['auth.ts', 'auth.md', 'other.ts', 'sub/auth.ts', 'sub/auth.md', 'sub/login.ts'];

// pattern, filePattern, ignoreCase, the files expected
const CASES = [
  ['auth', '*.ts', true, ['auth.ts', 'sub/auth.ts']],
  ['auth', '!*.md', true, ['auth.ts', 'sub/auth.ts']],
  ['auth', 'sub/*', true, ['sub/auth.md', 'sub/auth.ts']],
  ['auth', '*.md|*.txt', true, ['auth.md', 'sub/auth.md']],
  ['auth', '*.{md,txt}', true, ['auth.md', 'sub/auth.md']],
  ['*.ts', 'sub/*', true, ['sub/auth.ts', 'sub/login.ts']],
  ['auth', '*.TS', true, ['auth.ts', 'sub/auth.ts']],
  ['auth', '*.TS', false, []],
  // Without a filePattern: every file the pattern matches, as before
  ['auth', undefined, true, ['auth.md', 'auth.ts', 'sub/auth.md', 'sub/auth.ts']],
];

export default async function runTests() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-search-files-file-pattern-')));
  for (const rel of FILES) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), 'x');
  }
  const originalConfig = await configManager.getConfig();
  await configManager.setValue('allowedDirectories', [dir]);
  const failures = [];
  try {
    for (const [pattern, filePattern, ignoreCase, expected] of CASES) {
      const label = `file search "${pattern}", filePattern ${JSON.stringify(filePattern)}, ignoreCase ${ignoreCase}`;
      try {
        const { page } = await searchUntilDone({ path: dir, pattern, searchType: 'files', filePattern, ignoreCase });
        const found = filesInAnswer(page.content[0].text, dir);
        assert.deepStrictEqual(found, expected, `${label} found ${found.join(', ') || 'nothing'}, expected ${expected.join(', ') || 'nothing'}`);
        console.log(`✓ ${label}: ${expected.join(', ') || 'nothing'}`);
      } catch (error) {
        failures.push(label);
        console.log(`✗ ${label}\n  ${error.message}`);
      }
    }
  } finally {
    searchManager.dispose();
    await configManager.updateConfig(originalConfig);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  if (failures.length > 0) {
    console.log(`❌ ${failures.length} of ${CASES.length} file-search filePattern cases failed`);
    return false;
  }
  console.log('✅ A file search keeps to its filePattern');
  return true;
}

runIfMain(import.meta.url, runTests);
