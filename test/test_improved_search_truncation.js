// Test that long matching lines are shortened in search output so responses stay small
import assert from 'assert';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { configManager } from '../dist/config-manager.js';
import { handleGetMoreSearchResults, handleStopSearch } from '../dist/handlers/search-handlers.js';
import { runIfMain } from './helpers/run-if-main.js';
import { startSearchAndWait } from './helpers/search.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, 'improved-search-truncation-test');
const MATCH_PREVIEW_CHARS = 100; // search output shows at most this much of each matching line
const LONG_LINE = 'needle' + 'x'.repeat(5000);

async function testImprovedSearchTruncation() {
  console.log('Testing that long matching lines are shortened in search output...');

  await fs.writeFile(path.join(TEST_DIR, 'long-line.txt'), `short line\n${LONG_LINE}\n`);

  // Results show the matched text, so match the whole long line to get a long match
  const sessionId = await startSearchAndWait({
    path: TEST_DIR,
    pattern: 'needlex+',
    searchType: 'content'
  }, 30000);

  try {
    const page = await handleGetMoreSearchResults({ sessionId });
    assert.strictEqual(page.structuredContent.totalMatches, 1, 'Should find the one long line');

    const text = page.content[0].text;
    const preview = `${LONG_LINE.substring(0, MATCH_PREVIEW_CHARS)}...`;
    assert(text.includes(`long-line.txt:2 - ${preview}`), `Match should be cut to ${MATCH_PREVIEW_CHARS} characters plus "...", got: ${text.slice(0, 500)}`);
    assert(!text.includes(LONG_LINE.substring(0, MATCH_PREVIEW_CHARS + 1)), 'Output should not contain the rest of the long line');
    assert(text.length < LONG_LINE.length, `Response (${text.length} chars) should be smaller than the matching line (${LONG_LINE.length} chars)`);
    console.log(`✓ ${LONG_LINE.length}-character line shown as ${MATCH_PREVIEW_CHARS} characters + "..." (response ${text.length} chars)`);
  } finally {
    await handleStopSearch({ sessionId });
  }

  console.log('✅ Long matching lines are shortened in search output');
}

export default async function runTests() {
  const originalConfig = await configManager.getConfig();
  await fs.mkdir(TEST_DIR, { recursive: true });
  await configManager.setValue('allowedDirectories', [TEST_DIR]);
  try {
    await testImprovedSearchTruncation();
  } finally {
    await configManager.updateConfig(originalConfig);
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  }
}

runIfMain(import.meta.url, runTests);
