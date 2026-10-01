/**
 * Tests which hidden files and directories (names starting with '.') searches
 * find, with and without includeHidden - the long-standing behavior, for file
 * and content searches, every pattern shape, and the Excel/DOCX searches:
 * - With no glob, ripgrep's own rule decides: hidden files and directories only
 *   with includeHidden.
 * - A glob (a file search's pattern, a filePattern) lets the hidden files it
 *   matches through even with includeHidden false, and a hidden directory whose
 *   name it matches is entered (ripgrep's globs override its hidden-file rule):
 *   "*.txt" finds ".hidden.txt", "*" finds everything.
 * - The Excel and DOCX searches walk the files themselves: they read hidden
 *   files, and enter a directory whose name starts with '.' only with
 *   includeHidden (or when it is the search path itself).
 */

import assert from 'assert';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { handleGetMoreSearchResults, handleStopSearch } from '../dist/handlers/search-handlers.js';
import { searchManager } from '../dist/search-manager.js';
import { writeFile } from '../dist/tools/filesystem.js';
import { configManager } from '../dist/config-manager.js';
import { startSearchAndWait } from './helpers/search.js';
import { runIfMain } from './helpers/run-if-main.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, 'search-hidden-test');

// Every text file holds 'needle' on line 1; every Office file holds 'needle report'.
// .git makes the test directory a git repository of its own, so the enclosing
// repository's .gitignore (which lists .env) does not apply in it; the test
// directory's own .gitignore holds one rule, "needle", which matches no file.
const VISIBLE_TEXT = ['notes.txt', 'visible/not-hidden.txt', 'visible/plain.txt'];
const HIDDEN_TEXT = ['.hidden.txt', 'visible/.dot.txt', '.hidden-dir/inner.txt', '.hidden-dir/hidden-notes.txt', '.hidden-dir/.nested.txt'];
const HIDDEN_DOTFILES = ['.env', 'visible/.env', '.hidden-dir/.env', '.gitignore', '.git/HEAD', '.git/.gitkeep'];
const VISIBLE_OFFICE = ['report.xlsx', 'memo.docx'];
const HIDDEN_OFFICE = ['.hidden-report.xlsx', '.hidden-memo.docx', 'visible/.dot-memo.docx',
  '.hidden-dir/inner.xlsx', '.hidden-dir/inner.docx', '.hidden-dir/.nested.xlsx'];

/** Runs a search to completion; returns its results (sorted: file order varies) and match count */
async function runSearch(searchArgs) {
  const sessionId = await startSearchAndWait({ path: TEST_DIR, ...searchArgs });
  try {
    const page = await handleGetMoreSearchResults({ sessionId, offset: 0, length: 100 });
    assert(!page.isError, `Reading the results should succeed, got: ${page.content[0].text}`);
    const results = [...searchManager.readSearchResults(sessionId).results]
      .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : (a.line ?? 0) - (b.line ?? 0)));
    return { totalMatches: page.structuredContent.totalMatches, results };
  } finally {
    await handleStopSearch({ sessionId });
  }
}

async function testIncludeHidden() {
  console.log('Testing which hidden files searches find, with and without includeHidden...');

  const root = await fs.realpath(TEST_DIR);
  const full = (rel) => path.join(root, ...rel.split('/'));
  const files = (rels) => rels.map(rel => ({ file: full(rel), type: 'file' }));
  const lines = (rels) => rels.map(rel => ({ file: full(rel), line: 1, match: 'needle', type: 'content' }));
  const officeMatches = (rels) => rels.map(rel => ({
    file: rel.endsWith('.xlsx') ? `${full(rel)}:Sheet1!Row1` : full(rel),
    line: 1,
    match: 'needle report',
    type: 'content'
  }));
  const sorted = (results) => [...results].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  // Every file of the fixture
  const ALL = [...VISIBLE_TEXT, ...HIDDEN_TEXT, ...HIDDEN_DOTFILES, ...VISIBLE_OFFICE, ...HIDDEN_OFFICE];

  const cases = [
    {
      // The glob lets the hidden files it matches through; .hidden-dir's name does not match, so it is not entered
      label: 'file search, glob pattern "*.txt"',
      args: { pattern: '*.txt', searchType: 'files' },
      withoutHidden: files([...VISIBLE_TEXT, '.hidden.txt', 'visible/.dot.txt']),
      withHidden: files([...VISIBLE_TEXT, ...HIDDEN_TEXT])
    },
    {
      // "*" matches every name, hidden directories (.hidden-dir, .git) included, so it finds everything
      label: 'file search, glob pattern "*"',
      args: { pattern: '*', searchType: 'files' },
      withoutHidden: files(ALL),
      withHidden: files(ALL)
    },
    {
      // Becomes the glob "*hidden*", which matches the hidden directory's name too, so it is entered
      label: 'file search, substring pattern "hidden"',
      args: { pattern: 'hidden', searchType: 'files' },
      withoutHidden: files(['visible/not-hidden.txt', '.hidden.txt', '.hidden-dir/hidden-notes.txt', '.hidden-report.xlsx', '.hidden-memo.docx']),
      withHidden: files(['visible/not-hidden.txt', '.hidden.txt', '.hidden-dir/hidden-notes.txt', '.hidden-report.xlsx', '.hidden-memo.docx'])
    },
    {
      label: 'file search, exact filename ".hidden.txt"',
      args: { pattern: '.hidden.txt', searchType: 'files' },
      withoutHidden: files(['.hidden.txt']),
      withHidden: files(['.hidden.txt'])
    },
    {
      // earlyTermination: false, to get every match. .hidden-dir's name does not match, so it is only entered with includeHidden
      label: 'file search, exact filename ".env"',
      args: { pattern: '.env', searchType: 'files', earlyTermination: false },
      withoutHidden: files(['.env', 'visible/.env']),
      withHidden: files(['.env', 'visible/.env', '.hidden-dir/.env'])
    },
    {
      // ".git*" matches the .git directory too, so it is entered; .gitkeep inside it matches as well
      label: 'file search, glob pattern ".git*"',
      args: { pattern: '.git*', searchType: 'files' },
      withoutHidden: files(['.gitignore', '.git/.gitkeep']),
      withHidden: files(['.gitignore', '.git/.gitkeep'])
    },
    {
      // Becomes the glob "*.hidden-*", which matches the hidden directory's name too
      label: 'file search, substring pattern ".hidden-"',
      args: { pattern: '.hidden-', searchType: 'files' },
      withoutHidden: files(['.hidden-report.xlsx', '.hidden-memo.docx']),
      withHidden: files(['.hidden-report.xlsx', '.hidden-memo.docx'])
    },
    {
      // The glob matches the file's name, not its hidden directory's, so that directory is only entered with includeHidden
      label: 'file search, exact filename inside a hidden directory "inner.txt"',
      args: { pattern: 'inner.txt', searchType: 'files' },
      withoutHidden: [],
      withHidden: files(['.hidden-dir/inner.txt'])
    },
    {
      // No glob: ripgrep's own hidden-file rule decides
      label: 'content search, no filePattern',
      args: { pattern: 'needle', searchType: 'content', contextLines: 0 },
      withoutHidden: lines(VISIBLE_TEXT),
      withHidden: lines([...VISIBLE_TEXT, ...HIDDEN_TEXT, ...HIDDEN_DOTFILES])
    },
    {
      label: 'content search, filePattern "*.txt"',
      args: { pattern: 'needle', searchType: 'content', filePattern: '*.txt', contextLines: 0 },
      withoutHidden: lines([...VISIBLE_TEXT, '.hidden.txt', 'visible/.dot.txt']),
      withHidden: lines([...VISIBLE_TEXT, ...HIDDEN_TEXT])
    },
    {
      label: 'content search, filePattern ".env"',
      args: { pattern: 'needle', searchType: 'content', filePattern: '.env', contextLines: 0 },
      withoutHidden: lines(['.env', 'visible/.env']),
      withHidden: lines(['.env', 'visible/.env', '.hidden-dir/.env'])
    },
    {
      label: 'content search, filePattern "*.txt|.env"',
      args: { pattern: 'needle', searchType: 'content', filePattern: '*.txt|.env', contextLines: 0 },
      withoutHidden: lines([...VISIBLE_TEXT, '.hidden.txt', 'visible/.dot.txt', '.env', 'visible/.env']),
      withHidden: lines([...VISIBLE_TEXT, ...HIDDEN_TEXT, '.env', 'visible/.env', '.hidden-dir/.env'])
    },
    {
      // ".*" matches the hidden directories' names too, so they are entered; "!.env" leaves out the .env files
      label: 'content search, filePattern ".*|!.env"',
      args: { pattern: 'needle', searchType: 'content', filePattern: '.*|!.env', contextLines: 0 },
      withoutHidden: lines(['.hidden.txt', 'visible/.dot.txt', '.gitignore', '.hidden-dir/.nested.txt', '.git/.gitkeep']),
      withHidden: lines(['.hidden.txt', 'visible/.dot.txt', '.gitignore', '.hidden-dir/.nested.txt', '.git/.gitkeep'])
    },
    {
      // The Excel and DOCX searches walk the files themselves: they read hidden files,
      // and enter the directories whose name starts with '.' only with includeHidden
      label: 'content search, filePattern "*.xlsx|*.docx"',
      args: { pattern: 'needle', searchType: 'content', filePattern: '*.xlsx|*.docx', contextLines: 0 },
      withoutHidden: officeMatches([...VISIBLE_OFFICE, '.hidden-report.xlsx', '.hidden-memo.docx', 'visible/.dot-memo.docx']),
      withHidden: officeMatches([...VISIBLE_OFFICE, ...HIDDEN_OFFICE])
    },
    {
      label: 'content search, filePattern ".*.xlsx|.*.docx"',
      args: { pattern: 'needle', searchType: 'content', filePattern: '.*.xlsx|.*.docx', contextLines: 0 },
      withoutHidden: officeMatches(['.hidden-report.xlsx', '.hidden-memo.docx', 'visible/.dot-memo.docx']),
      withHidden: officeMatches(['.hidden-report.xlsx', '.hidden-memo.docx', 'visible/.dot-memo.docx', '.hidden-dir/.nested.xlsx'])
    },
    {
      // A hidden directory given as the path is searched; "*" lets the hidden files inside it through
      label: 'file search in a hidden directory, glob pattern "*"',
      args: { path: path.join(TEST_DIR, '.hidden-dir'), pattern: '*', searchType: 'files' },
      withoutHidden: files(['.hidden-dir/inner.txt', '.hidden-dir/hidden-notes.txt', '.hidden-dir/inner.xlsx', '.hidden-dir/inner.docx',
        '.hidden-dir/.nested.txt', '.hidden-dir/.env', '.hidden-dir/.nested.xlsx']),
      withHidden: files(['.hidden-dir/inner.txt', '.hidden-dir/hidden-notes.txt', '.hidden-dir/inner.xlsx', '.hidden-dir/inner.docx',
        '.hidden-dir/.nested.txt', '.hidden-dir/.env', '.hidden-dir/.nested.xlsx'])
    },
    {
      // A hidden directory given as the path is walked by the Excel and DOCX searches, hidden files inside it included
      label: 'content search in a hidden directory, filePattern "*.xlsx|*.docx"',
      args: { path: path.join(TEST_DIR, '.hidden-dir'), pattern: 'needle', searchType: 'content', filePattern: '*.xlsx|*.docx', contextLines: 0 },
      withoutHidden: officeMatches(['.hidden-dir/inner.xlsx', '.hidden-dir/inner.docx', '.hidden-dir/.nested.xlsx']),
      withHidden: officeMatches(['.hidden-dir/inner.xlsx', '.hidden-dir/inner.docx', '.hidden-dir/.nested.xlsx'])
    },
  ];

  for (const { label, args, withoutHidden, withHidden } of cases) {
    for (const includeHidden of [false, true]) {
      const expected = sorted(includeHidden ? withHidden : withoutHidden);
      const actual = await runSearch({ ...args, includeHidden });
      assert.deepStrictEqual(actual, { totalMatches: expected.length, results: expected },
        `${label}, includeHidden: ${includeHidden}`);
    }
    console.log(`✓ ${label}: ${withoutHidden.length} results without hidden files, ${withHidden.length} with them`);
  }
}

export default async function runTests() {
  const originalConfig = await configManager.getConfig();
  await fs.rm(TEST_DIR, { recursive: true, force: true });
  await fs.mkdir(path.join(TEST_DIR, 'visible'), { recursive: true });
  await fs.mkdir(path.join(TEST_DIR, '.hidden-dir'), { recursive: true });
  await fs.mkdir(path.join(TEST_DIR, '.git'), { recursive: true });
  await configManager.setValue('allowedDirectories', [TEST_DIR]);
  try {
    for (const rel of [...VISIBLE_TEXT, ...HIDDEN_TEXT, ...HIDDEN_DOTFILES]) {
      await fs.writeFile(path.join(TEST_DIR, rel), 'needle\n');
    }
    // Real Office files, written by Desktop Commander's own Excel and DOCX handlers
    for (const rel of [...VISIBLE_OFFICE, ...HIDDEN_OFFICE]) {
      const content = rel.endsWith('.xlsx') ? JSON.stringify([['needle report']]) : 'needle report';
      await writeFile(path.join(TEST_DIR, rel), content);
    }

    await testIncludeHidden();
    console.log('✅ Hidden file search tests passed');
  } finally {
    // Stop any search still running (before its files are removed) and drop all sessions
    searchManager.dispose();
    await configManager.updateConfig(originalConfig);
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  }
}

runIfMain(import.meta.url, runTests);
