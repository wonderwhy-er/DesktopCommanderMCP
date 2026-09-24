/**
 * A search that could not run answers with an error, not with "No matches
 * found". An invalid regular expression and a path that doesn't exist both
 * answered "No matches found … Some files were inaccessible due to permissions":
 * ripgrep's own report ("rg: regex parse error", "rg: <path>: …") was dropped
 * as a system message, and its exit code 2 taken for files it couldn't read.
 * - An invalid pattern: get_more_search_results answers with the error it
 *   gives for a failed search ("Search session … encountered an error: …").
 * - A missing path: start_search answers with the error it gives when a search
 *   can't start ("Error starting search session: …").
 * A search that only met unreadable files still ends with its results and the
 * permissions warning (test-search-code.js and others).
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { searchManager } from '../dist/search-manager.js';
import { configManager } from '../dist/config-manager.js';
import { searchUntilDone } from './helpers/search.js';
import { runIfMain } from './helpers/run-if-main.js';

export default async function runTests() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-search-failed-')));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  const missing = path.join(dir, 'nope');
  const originalConfig = await configManager.getConfig();
  await configManager.setValue('allowedDirectories', [dir]);

  const cases = [
    ['an invalid regular expression, content search', async () => {
      const { started, page } = await searchUntilDone({ path: dir, pattern: '(unclosed', searchType: 'content' });
      assert(!started.isError, `start_search should start the search, got: ${started.content[0].text}`);
      const text = page.content[0].text;
      assert(page.isError && /^Search session \S+ encountered an error: /.test(text) && text.includes('regex parse error'),
        `a search for the invalid regex "(unclosed" should answer with ripgrep's error, got:\n${text}`);
    }],
    ['a missing path, content search', async () => {
      const { started, page } = await searchUntilDone({ path: missing, pattern: 'hello', searchType: 'content' });
      const text = (page ?? started).content[0].text;
      assert(started.isError && text.startsWith('Error starting search session: ') && text.includes(missing),
        `a search of the missing path ${missing} should not start, got:\n${text}`);
    }],
    ['a missing path, file search', async () => {
      const { started, page } = await searchUntilDone({ path: missing, pattern: 'hello', searchType: 'files' });
      const text = (page ?? started).content[0].text;
      assert(started.isError && text.startsWith('Error starting search session: ') && text.includes(missing),
        `a file search of the missing path ${missing} should not start, got:\n${text}`);
    }],
    ['a valid search still ends normally', async () => {
      const { page } = await searchUntilDone({ path: dir, pattern: 'hello', searchType: 'content' });
      assert(!page.isError && page.structuredContent.totalMatches === 1, `a search for "hello" should find it, got:\n${page.content[0].text}`);
    }],
  ];

  const failures = [];
  try {
    for (const [label, run] of cases) {
      try {
        await run();
        console.log(`✓ ${label}`);
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
    console.log(`❌ ${failures.length} of ${cases.length} failed-search cases failed`);
    return false;
  }
  console.log('✅ A search that could not run answers with an error');
  return true;
}

runIfMain(import.meta.url, runTests);
