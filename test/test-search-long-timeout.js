/**
 * A timeout_ms longer than a timer can wait (2^31 - 1 ms, ~24.8 days) is still
 * a time limit, not an immediate stop. 3000000000 ms stopped the search at
 * once, with part of its results (240 of 1000) and "Timed out": Node fires such
 * a timer after 1 ms. A search under such a limit ends on its own, complete.
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { searchManager } from '../dist/search-manager.js';
import { configManager } from '../dist/config-manager.js';
import { searchUntilDone } from './helpers/search.js';
import { runIfMain } from './helpers/run-if-main.js';

const FILES = 50;
const LINES = 20;

export default async function runTests() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-search-long-timeout-')));
  for (let i = 0; i < FILES; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), 'abc\n'.repeat(LINES));
  const originalConfig = await configManager.getConfig();
  await configManager.setValue('allowedDirectories', [dir]);
  const failures = [];
  try {
    for (const timeout_ms of [3_000_000_000, 2 ** 31]) {
      const label = `timeout_ms ${timeout_ms}`;
      try {
        const { page } = await searchUntilDone({ path: dir, pattern: 'abc', searchType: 'content', contextLines: 0, timeout_ms });
        const { totalMatches, timedOut } = page.structuredContent;
        assert(!timedOut && totalMatches === FILES * LINES,
          `a search with ${label} should run to its end: ${totalMatches} of ${FILES * LINES} matches, timedOut ${timedOut}`);
        console.log(`✓ ${label}: all ${totalMatches} matches, not timed out`);
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
    console.log(`❌ ${failures.length} of 2 long time limits failed`);
    return false;
  }
  console.log('✅ A time limit longer than a timer can wait does not stop the search at once');
  return true;
}

runIfMain(import.meta.url, runTests);
