// Run by test-search-stopped-not-failed.js with ripgrep-still-searching-preload.mjs:
// node --import <preload> search-stopped-by-time-limit.mjs <folder>
// Runs a content search with a 1 s time limit until it ends and prints, as JSON
// on its last line, what get_more_search_results answered (and its internal timedOut).
import { searchUntilDone } from '../helpers/search.js';
import { searchManager } from '../../dist/search-manager.js';

const [folder] = process.argv.slice(2);
const { started, page } = await searchUntilDone({ path: folder, pattern: 'needle', searchType: 'content', timeout_ms: 1000 });
searchManager.dispose();
const answer = page ?? started;
console.log(JSON.stringify({ isError: !!answer.isError, text: answer.content[0].text, timedOut: answer.structuredContent?.timedOut }));
