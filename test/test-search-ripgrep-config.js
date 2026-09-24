/**
 * Tests that the user's ripgrep config file (RIPGREP_CONFIG_PATH) does not
 * change Desktop Commander's searches. start_search builds ripgrep's complete
 * argument list from its own arguments (ignoreCase, includeHidden,
 * filePattern, maxResults...), so flags from that file would silently change
 * which files are searched, how many matches each gives, and the output
 * Desktop Commander parses.
 */

import assert from 'assert';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { handleGetMoreSearchResults, handleStopSearch } from '../dist/handlers/search-handlers.js';
import { searchManager } from '../dist/search-manager.js';
import { configManager } from '../dist/config-manager.js';
import { startSearchAndWait } from './helpers/search.js';
import { runIfMain } from './helpers/run-if-main.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, 'search-ripgrep-config-test');
const SEARCH_DIR = path.join(TEST_DIR, 'files');
const RIPGREP_CONFIG = path.join(TEST_DIR, 'ripgreprc');

// Each flag changes what at least one of the searches below finds or how its output looks
const RIPGREP_CONFIG_FLAGS = [
  '--max-count=1',     // one match per file
  '--glob=!*.md',      // skip Markdown files
  '--hidden',          // search hidden files
  '--smart-case',      // an all-lowercase pattern matches any case
  '--context=1',       // a context line around every match
  '--null',            // file paths end in NUL instead of a newline
];

/** Runs a search to completion; returns its results (sorted: ripgrep's file order varies) and counts */
async function runSearch(searchArgs) {
  const sessionId = await startSearchAndWait({ path: SEARCH_DIR, ...searchArgs });
  try {
    const page = await handleGetMoreSearchResults({ sessionId, offset: 0, length: 100 });
    assert(!page.isError, `Reading the results should succeed, got: ${page.content[0].text}`);
    const { totalResults, totalMatches, isComplete } = page.structuredContent;
    const results = [...searchManager.readSearchResults(sessionId).results]
      .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : (a.line ?? 0) - (b.line ?? 0)));
    return { isComplete, totalResults, totalMatches, results };
  } finally {
    await handleStopSearch({ sessionId });
  }
}

/** Runs a search with RIPGREP_CONFIG_PATH set to `configPath`, or unset */
async function runSearchWithRipgrepConfig(configPath, searchArgs) {
  const original = process.env.RIPGREP_CONFIG_PATH;
  if (configPath === undefined) delete process.env.RIPGREP_CONFIG_PATH;
  else process.env.RIPGREP_CONFIG_PATH = configPath;
  try {
    return await runSearch(searchArgs);
  } finally {
    if (original === undefined) delete process.env.RIPGREP_CONFIG_PATH;
    else process.env.RIPGREP_CONFIG_PATH = original;
  }
}

/**
 * Each search finds exactly the same results with and without a ripgrep
 * config file that would change them
 */
async function testRipgrepConfigDoesNotChangeResults() {
  console.log('Testing that a ripgrep config file does not change search results...');

  const root = await fs.realpath(SEARCH_DIR);
  const notes = path.join(root, 'notes.txt');
  const readme = path.join(root, 'readme.md');
  const hidden = path.join(root, '.hidden.txt');
  const match = (file, line, text) => ({ file, line, match: text, type: 'content' });

  const cases = [
    {
      label: 'content search (ignoreCase default, no context lines)',
      args: { pattern: 'needle', searchType: 'content', contextLines: 0 },
      expected: {
        isComplete: true, totalResults: 4, totalMatches: 4,
        results: [match(notes, 1, 'needle'), match(notes, 3, 'needle'), match(notes, 5, 'NEEDLE'), match(readme, 1, 'needle')]
      }
    },
    {
      label: 'content search (ignoreCase: false, no context lines)',
      args: { pattern: 'needle', searchType: 'content', contextLines: 0, ignoreCase: false },
      expected: {
        isComplete: true, totalResults: 3, totalMatches: 3,
        results: [match(notes, 1, 'needle'), match(notes, 3, 'needle'), match(readme, 1, 'needle')]
      }
    },
    {
      // The config file's --glob=!*.md must not leave readme.md out. The long-standing
      // behavior: a filePattern glob lets the hidden files it matches through even
      // with includeHidden false (ripgrep's globs override its hidden-file rule), so
      // "*.txt" finds .hidden.txt
      label: 'content search with a filePattern (no context lines)',
      args: { pattern: 'needle', searchType: 'content', contextLines: 0, filePattern: '*.txt|*.md' },
      expected: {
        isComplete: true, totalResults: 5, totalMatches: 5,
        results: [match(hidden, 1, 'needle'), match(notes, 1, 'needle'), match(notes, 3, 'needle'), match(notes, 5, 'NEEDLE'), match(readme, 1, 'needle')]
      }
    },
    {
      // The config file's --null must not change how the listed paths end. As
      // above, the glob "*.txt" lets the hidden .hidden.txt through (long-standing
      // behavior), so the config file's --hidden adds nothing here
      label: 'file search',
      args: { pattern: '*.txt', searchType: 'files' },
      expected: {
        isComplete: true, totalResults: 3, totalMatches: 3,
        results: [
          { file: hidden, type: 'file' },
          { file: notes, type: 'file' },
          { file: path.join(root, 'todo.txt'), type: 'file' }
        ]
      }
    },
  ];

  for (const { label, args, expected } of cases) {
    const withoutConfig = await runSearchWithRipgrepConfig(undefined, args);
    assert.deepStrictEqual(withoutConfig, expected, `${label} without a ripgrep config file`);

    const withConfig = await runSearchWithRipgrepConfig(RIPGREP_CONFIG, args);
    assert.deepStrictEqual(withConfig, expected,
      `${label}: the ripgrep config file (${RIPGREP_CONFIG_FLAGS.join(' ')}) must not change the results`);

    console.log(`✓ ${label}: same ${expected.totalMatches} results with the ripgrep config file`);
  }
}

export default async function runTests() {
  const originalConfig = await configManager.getConfig();
  await fs.rm(TEST_DIR, { recursive: true, force: true });
  await fs.mkdir(SEARCH_DIR, { recursive: true });
  await fs.writeFile(path.join(SEARCH_DIR, 'notes.txt'), 'needle\nhay\nneedle\nhay\nNEEDLE\n');
  await fs.writeFile(path.join(SEARCH_DIR, 'todo.txt'), 'nothing here\n');
  await fs.writeFile(path.join(SEARCH_DIR, 'readme.md'), 'needle\n');
  await fs.writeFile(path.join(SEARCH_DIR, '.hidden.txt'), 'needle\n');
  await fs.writeFile(RIPGREP_CONFIG, `${RIPGREP_CONFIG_FLAGS.join('\n')}\n`);
  await configManager.setValue('allowedDirectories', [SEARCH_DIR]);
  try {
    await testRipgrepConfigDoesNotChangeResults();
    console.log('✅ Ripgrep config tests passed');
  } finally {
    // Stop any search still running (before its files are removed) and drop all sessions
    searchManager.dispose();
    await configManager.updateConfig(originalConfig);
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  }
}

runIfMain(import.meta.url, runTests);
