/**
 * What a search keeps of ripgrep's error output (stderr): each piece once, and
 * no more than a bounded amount. It is the error an answer shows when a search
 * fails without results, and a session keeps it until it is cleaned up.
 * Before, every chunk was kept whole and its "meaningful" lines (those not
 * starting with "rg:") a second time, without limit.
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { searchManager } from '../dist/search-manager.js';
import { configManager } from '../dist/config-manager.js';
import { startSearchAndWait } from './helpers/search.js';
import { runIfMain } from './helpers/run-if-main.js';

const MAX_KEPT_CHARS = 64 * 1024;

export default async function runTests() {
  const originalConfig = await configManager.getConfig();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-search-errors-')));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'text\n');
  await configManager.setValue('allowedDirectories', [dir]);
  let sessionId;
  try {
    // An unclosed group: ripgrep writes its regex error to stderr and exits
    sessionId = await startSearchAndWait({ path: dir, pattern: '(unclosed', searchType: 'content' });
    const { error } = searchManager.readSearchResults(sessionId);
    const occurrences = (error ?? '').split('unclosed group').length - 1;
    assert.strictEqual(occurrences, 1, `ripgrep's error should be kept once, got ${occurrences} times:\n${error}`);
    console.log('✓ ripgrep\'s error output is kept once');

    // More error output than a session keeps, through the session's own stderr handler
    const session = searchManager['sessions'].get(sessionId);
    session.process.stderr.emit('data', Buffer.from('x'.repeat(4 * MAX_KEPT_CHARS)));
    const kept = searchManager.readSearchResults(sessionId).error ?? '';
    assert(kept.length <= MAX_KEPT_CHARS, `a session should keep at most ${MAX_KEPT_CHARS} characters of error output, kept ${kept.length}`);
    assert(kept.includes('unclosed group'), 'what was kept first should stay');
    console.log(`✓ at most ${MAX_KEPT_CHARS} characters of error output are kept`);
  } finally {
    searchManager.dispose();
    await configManager.updateConfig(originalConfig);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return true;
}

runIfMain(import.meta.url, runTests);
