/**
 * literalSearch: true makes a file search's pattern an exact string ("Literal
 * (literalSearch=true): Patterns are treated as exact strings"). It was still
 * a glob: "report[1].txt" found report1.txt ("[1]" a character class) and not
 * report[1].txt. Without literalSearch a file search's pattern stays a glob.
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { searchManager } from '../dist/search-manager.js';
import { configManager } from '../dist/config-manager.js';
import { searchUntilDone, filesInAnswer } from './helpers/search.js';
import { runIfMain } from './helpers/run-if-main.js';

const FILES = ['report[1].txt', 'report1.txt', 'sub/report[1].txt', 'notes{a}.md', 'notesa.md'];

// pattern, literalSearch, the files expected
const CASES = [
  // An exact file name, anywhere below the search path
  ['report[1].txt', true, ['report[1].txt', 'sub/report[1].txt']],
  // A part of a name
  ['rt[1]', true, ['report[1].txt', 'sub/report[1].txt']],
  ['{a}', true, ['notes{a}.md']],
  // Globs as before
  ['report[1].txt', false, ['report1.txt']],
  ['notes{a,b}.md', false, ['notesa.md']],
];

export default async function runTests() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-search-files-literal-')));
  for (const rel of FILES) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), 'x');
  }
  const originalConfig = await configManager.getConfig();
  await configManager.setValue('allowedDirectories', [dir]);
  const failures = [];
  try {
    for (const [pattern, literalSearch, expected] of CASES) {
      const label = `file search "${pattern}", literalSearch ${literalSearch}`;
      try {
        // earlyTermination false: every file the pattern matches, not just the first exact one
        const { page } = await searchUntilDone({ path: dir, pattern, searchType: 'files', literalSearch, earlyTermination: false });
        const found = filesInAnswer(page.content[0].text, dir);
        assert.deepStrictEqual(found, expected, `${label} found ${found.join(', ') || 'nothing'}, expected ${expected.join(', ')}`);
        console.log(`✓ ${label}: ${expected.join(', ')}`);
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
    console.log(`❌ ${failures.length} of ${CASES.length} literal file-name cases failed`);
    return false;
  }
  console.log('✅ literalSearch makes a file search\'s pattern an exact string');
  return true;
}

runIfMain(import.meta.url, runTests);
