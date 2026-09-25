// Run by test-search-without-ripgrep.js with unusable-ripgrep-hooks.mjs:
// node <hookArgs(hooks)> search-without-ripgrep.mjs <root> <pattern>...
// Prints, as JSON, what start_search answers for a file search and for a
// content search, and what searchFiles() returns for each pattern - through
// its Node.js fallback.
import { handleStartSearch } from '../../dist/handlers/search-handlers.js';
import { searchFiles } from '../../dist/tools/filesystem.js';
import { searchManager } from '../../dist/search-manager.js';

const [rootPath, ...patterns] = process.argv.slice(2);

const startSearch = async (args) => {
  const result = await handleStartSearch({ path: rootPath, ...args });
  return { isError: !!result.isError, text: result.content[0].text };
};
const fileSearch = await startSearch({ pattern: 'notes', searchType: 'files' });
const contentSearch = await startSearch({ pattern: 'content', searchType: 'content', filePattern: '*.txt' });

const results = {};
for (const pattern of patterns) {
  results[pattern] = await searchFiles(rootPath, pattern);
}
searchManager.dispose();
console.log(JSON.stringify({ fileSearch, contentSearch, results }));
