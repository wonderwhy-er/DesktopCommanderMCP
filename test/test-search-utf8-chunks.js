/**
 * ripgrep's output reaches the server in chunks, cut wherever the pipe cuts
 * it, also inside a character that takes several bytes in UTF-8 ("€" takes 3).
 * Each chunk was decoded on its own, so such a character came out as two
 * U+FFFD: in the text a match shows, in its file's path, and in the file a
 * skipped line is counted under. The output must be decoded as one stream.
 *
 * The fixture's matches, and the folder and name of their file, are mostly
 * such characters, and there is enough output (~8 MB) that the pipe cuts it
 * many times.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { searchManager } from '../dist/search-manager.js';
import { configManager } from '../dist/config-manager.js';
import { handleStopSearch } from '../dist/handlers/search-handlers.js';
import { startSearchAndWait } from './helpers/search.js';
import { runIfMain } from './helpers/run-if-main.js';
import { createTempDir } from './helpers/test-env.js';

const LINES = 12_000;
/** What each line matches: under the 100 characters an answer shows, so it is kept whole */
const MATCH = `needle${'é€中😀'.repeat(18)}`;

export default async function runTests() {
  const originalConfig = await configManager.getConfig();
  const dir = createTempDir('dc-search-utf8-');
  const file = path.join(dir, 'Überordner-€', 'naïve-中.txt');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, `${MATCH}\n`.repeat(LINES));
  await configManager.setValue('allowedDirectories', [dir]);
  let sessionId;
  try {
    sessionId = await startSearchAndWait({ path: dir, pattern: 'needle.*', searchType: 'content', contextLines: 0 }, 30_000);
    const { results } = searchManager.readSearchResults(sessionId, 0, LINES + 1);
    assert.strictEqual(results.length, LINES, `the search should find each of the ${LINES} lines`);
    const changed = results.filter((result) => result.file !== file || result.match !== MATCH);
    assert.strictEqual(changed.length, 0,
      `${changed.length} of ${LINES} matches came out changed, e.g. file ${JSON.stringify(changed[0]?.file)}, match ${JSON.stringify(changed[0]?.match)}`);
    console.log(`✓ ${LINES} matches of multi-byte text, and their file's path, came out whole`);
  } finally {
    if (sessionId) await handleStopSearch({ sessionId });
    searchManager.dispose();
    await configManager.updateConfig(originalConfig);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return true;
}

runIfMain(import.meta.url, runTests);
