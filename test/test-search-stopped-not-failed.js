/**
 * A search that its time limit ended answers as such a search does: completed,
 * with what it found, not "encountered an error". A file search for an exact
 * name in C:\Windows (a 1.5 s limit by default) answered "Search session …
 * encountered an error: rg: C:\Windows\…: Access is denied" with 0 results:
 * ripgrep stopped by the time limit has no exit code, and a search ending
 * without one, with anything on stderr and no match, was taken for a failed one.
 * Here ripgrep is a stand-in that reports a folder it may not read and goes on
 * searching (fixtures/ripgrep-still-searching-preload.mjs), in a child process;
 * a 1 s time limit stops it (the session knows: its internal timedOut).
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { configManager } from '../dist/config-manager.js';
import { runNode } from './helpers/run-node.js';
import { runIfMain } from './helpers/run-if-main.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

export default async function runTests() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-search-stopped-')));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  const originalConfig = await configManager.getConfig();
  await configManager.setValue('allowedDirectories', [dir]);
  try {
    const child = await runNode([
      '--import', pathToFileURL(path.join(FIXTURES, 'ripgrep-still-searching-preload.mjs')).href,
      path.join(FIXTURES, 'search-stopped-by-time-limit.mjs'), dir,
    ], { timeoutMs: 60_000 });
    assert.strictEqual(child.status, 0, `the search process failed (${child.status}): ${child.stderr}`);
    const { isError, text, timedOut } = JSON.parse(child.stdout.trim().split('\n').pop());
    assert(!isError && /^Search session: /.test(text) && text.includes('Status: COMPLETED'),
      `a search its time limit stopped should end as completed, not failed; the answer was:\n${text}`);
    assert.strictEqual(timedOut, true, 'the session should know its time limit stopped it');
    console.log('✓ a search stopped by its time limit, after ripgrep reported a folder it may not read: completed, not an error');
  } catch (error) {
    console.log(`✗ a search stopped by its time limit ends as completed\n  ${error.message}`);
    return false;
  } finally {
    await configManager.updateConfig(originalConfig);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  console.log('✅ A search stopped by its time limit is not a failed one');
  return true;
}

runIfMain(import.meta.url, runTests);
