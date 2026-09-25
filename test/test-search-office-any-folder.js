/**
 * A content search's Excel and DOCX files, selected by a filePattern that starts
 * with "**\/" ("**\/*.xlsx": in any folder): the Excel and DOCX searches found
 * nothing for it, not even in the search path itself, while ripgrep's text files
 * matched it. They matched filePattern alternatives against file names only,
 * with '*' as the only wildcard. They match ripgrep's globs now, by one matcher
 * with a file search's filePattern, ignoring case as before
 * (test-search-file-pattern.js: paths, "[...]", "?", "{a,b}").
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { searchManager } from '../dist/search-manager.js';
import { configManager } from '../dist/config-manager.js';
import { writeFile } from '../dist/tools/filesystem.js';
import { searchUntilDone, filesInAnswer } from './helpers/search.js';
import { runIfMain } from './helpers/run-if-main.js';

// filePattern, the Excel/DOCX files expected
const CASES = [
  ['**/*.xlsx', ['a.xlsx', 'sub/b.xlsx']],
  ['**/*.docx', ['memo.docx', 'sub/deep/memo2.docx']],
  ['**/b.xlsx|**/memo2.docx', ['sub/b.xlsx', 'sub/deep/memo2.docx']],
  ['**/*.xlsx|!**/b.xlsx', ['a.xlsx']],
];

export default async function runTests() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-search-office-any-folder-')));
  const originalConfig = await configManager.getConfig();
  await configManager.setValue('allowedDirectories', [dir]);
  const failures = [];
  try {
    fs.mkdirSync(path.join(dir, 'sub', 'deep'), { recursive: true });
    // Real Office files, written by Desktop Commander's own Excel and DOCX handlers
    for (const rel of ['a.xlsx', 'sub/b.xlsx']) await writeFile(path.join(dir, rel), JSON.stringify([['needle']]));
    for (const rel of ['memo.docx', 'sub/deep/memo2.docx']) await writeFile(path.join(dir, rel), 'needle');

    for (const [filePattern, expected] of CASES) {
      const label = `content search "needle", filePattern "${filePattern}"`;
      try {
        const { page } = await searchUntilDone({ path: dir, pattern: 'needle', searchType: 'content', filePattern });
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
    console.log(`❌ ${failures.length} of ${CASES.length} "**/" filePattern cases failed`);
    return false;
  }
  console.log('✅ Excel and DOCX files in any folder match a "**/" filePattern');
  return true;
}

runIfMain(import.meta.url, runTests);
