// Test that large search result sets are returned in bounded pages (streaming API)
import assert from 'assert';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { configManager } from '../dist/config-manager.js';
import { handleGetMoreSearchResults, handleStopSearch } from '../dist/handlers/search-handlers.js';
import { runIfMain } from './helpers/run-if-main.js';
import { startSearchAndWait } from './helpers/search.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, 'search-truncation-test');
const MATCHING_LINES = 250;
const PAGE_SIZE = 100; // get_more_search_results default length

async function testSearchTruncation() {
  console.log('Testing that large search results are paged...');

  const lines = Array.from({ length: MATCHING_LINES }, (_, i) => `match line ${i}`);
  await fs.writeFile(path.join(TEST_DIR, 'many-matches.txt'), lines.join('\n') + '\n');

  const sessionId = await startSearchAndWait({
    path: TEST_DIR,
    pattern: 'match line',
    searchType: 'content',
    maxResults: 50000
  }, 30000);

  try {
    // Pages of PAGE_SIZE until the remainder: 100, 100, 50
    const expectedPages = [
      { offset: 0, returnedCount: 100, hasMoreResults: true },
      { offset: 100, returnedCount: 100, hasMoreResults: true },
      { offset: 200, returnedCount: 50, hasMoreResults: false },
    ];
    for (const expected of expectedPages) {
      const page = await handleGetMoreSearchResults({ sessionId, offset: expected.offset });
      const data = page.structuredContent;
      assert.strictEqual(data.totalMatches, MATCHING_LINES, 'Should count every matching line');
      assert.strictEqual(data.returnedCount, expected.returnedCount, `Page at offset ${expected.offset} should hold ${expected.returnedCount} results`);
      assert.strictEqual(data.hasMoreResults, expected.hasMoreResults, `Page at offset ${expected.offset} hasMoreResults`);
      if (expected.hasMoreResults) {
        assert(page.content[0].text.includes(`offset: ${expected.offset + PAGE_SIZE}`),
          'Should tell the caller which offset to request next');
      }
      console.log(`✓ offset ${expected.offset}: ${data.returnedCount} of ${data.totalMatches} results, more: ${data.hasMoreResults}`);
    }
  } finally {
    await handleStopSearch({ sessionId });
  }

  console.log('✅ Large search results are returned in bounded pages');
}

export default async function runTests() {
  const originalConfig = await configManager.getConfig();
  await fs.mkdir(TEST_DIR, { recursive: true });
  await configManager.setValue('allowedDirectories', [TEST_DIR]);
  try {
    await testSearchTruncation();
  } finally {
    await configManager.updateConfig(originalConfig);
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  }
}

runIfMain(import.meta.url, runTests);
