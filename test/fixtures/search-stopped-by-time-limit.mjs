// Run by test-search-stopped-not-failed.js and test-search-outcome.js with ripgrep-still-searching-hooks.mjs:
// node <hookArgs(hooks)> search-stopped-by-time-limit.mjs <folder> [<search arguments, JSON>]
// Runs a search (by default a content search with a 1 s time limit) until it
// ends and prints, as JSON on its last line, what get_more_search_results
// answered (and the session's internal outcome).
import { searchUntilDone } from '../helpers/search.js';
import { searchManager } from '../../dist/search-manager.js';

const [folder, searchArgs] = process.argv.slice(2);
const search = searchArgs ? JSON.parse(searchArgs) : { pattern: 'needle', searchType: 'content', timeout_ms: 1000 };
const { started, page } = await searchUntilDone({ path: folder, ...search });
searchManager.dispose();
const answer = page ?? started;
console.log(JSON.stringify({ isError: !!answer.isError, text: answer.content[0].text, outcome: answer.structuredContent?.outcome }));
