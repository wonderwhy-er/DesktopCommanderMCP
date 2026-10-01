/**
 * Tests which files and directories with the Windows hidden attribute (names
 * not starting with '.') searches find, with and without includeHidden - the
 * long-standing behavior: with no glob, ripgrep's own rule leaves them out
 * unless includeHidden; a glob (a file search's pattern, a filePattern) lets
 * the ones it matches through even with includeHidden false, and a hidden
 * directory whose name it matches is entered (ripgrep's globs override its
 * hidden-file rule); the Excel and DOCX searches don't look at the attribute,
 * whatever includeHidden says; a hidden directory given as the path is searched.
 * Skipped on other platforms, which have no hidden attribute.
 */

import assert from 'assert';
import path from 'path';
import fs from 'fs/promises';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { handleGetMoreSearchResults, handleStopSearch } from '../dist/handlers/search-handlers.js';
import { searchManager } from '../dist/search-manager.js';
import { writeFile } from '../dist/tools/filesystem.js';
import { configManager } from '../dist/config-manager.js';
import { startSearchAndWait } from './helpers/search.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, 'search-hidden-attribute-test');

// Each stem is written as <stem>.txt (holding 'needle'), .xlsx and .docx (holding 'needle report').
// attr-hidden.* have the hidden attribute, and so has the directory attr-dir.
const VISIBLE = ['plain'];
const ATTR_HIDDEN_FILES = ['attr-hidden'];
const IN_ATTR_HIDDEN_DIR = ['attr-dir/inner'];
const EXTENSIONS = ['txt', 'xlsx', 'docx'];

/** Runs a search to completion; returns its results (sorted: file order varies) and match count */
async function runSearch(searchArgs) {
  const sessionId = await startSearchAndWait({ path: TEST_DIR, ...searchArgs });
  try {
    const page = await handleGetMoreSearchResults({ sessionId, offset: 0, length: 100 });
    assert(!page.isError, `Reading the results should succeed, got: ${page.content[0].text}`);
    const results = [...searchManager.readSearchResults(sessionId).results]
      .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    return { totalMatches: page.structuredContent.totalMatches, results };
  } finally {
    await handleStopSearch({ sessionId });
  }
}

/** Sets the hidden attribute of a file or directory */
function setHiddenAttribute(target) {
  const attrib = spawnSync('attrib', ['+h', target], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.strictEqual(attrib.status, 0, `attrib +h ${target} failed: ${attrib.error ?? attrib.stdout + attrib.stderr}`);
}

async function testHiddenAttribute() {
  console.log('Testing which entries with the Windows hidden attribute searches find...');

  const root = await fs.realpath(TEST_DIR);
  const full = (rel) => path.join(root, ...rel.split('/'));
  const sorted = (results) => [...results].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const files = (stems, exts) => stems.flatMap((stem) => exts.map((ext) => ({ file: full(`${stem}.${ext}`), type: 'file' })));
  const matches = (stems, exts) => stems.flatMap((stem) => exts.map((ext) => ({
    file: ext === 'xlsx' ? `${full(`${stem}.xlsx`)}:Sheet1!Row1` : full(`${stem}.${ext}`),
    line: 1,
    match: ext === 'txt' ? 'needle' : 'needle report',
    type: 'content'
  })));

  const ALL = [...VISIBLE, ...ATTR_HIDDEN_FILES, ...IN_ATTR_HIDDEN_DIR];

  const cases = [
    {
      // "*" matches every name, attr-hidden.* and attr-dir included, so ripgrep reads them all;
      // the Excel and DOCX searches don't look at the hidden attribute at all
      label: 'content search, filePattern "*.txt|*.xlsx|*.docx|*"',
      args: { pattern: 'needle', searchType: 'content', filePattern: '*.txt|*.xlsx|*.docx|*' },
      withoutHidden: matches(ALL, EXTENSIONS),
      withHidden: matches(ALL, EXTENSIONS)
    },
    {
      // The Excel and DOCX searches don't look at the hidden attribute
      label: 'content search, filePattern "*.xlsx|*.docx"',
      args: { pattern: 'needle', searchType: 'content', filePattern: '*.xlsx|*.docx' },
      withoutHidden: matches(ALL, ['xlsx', 'docx']),
      withHidden: matches(ALL, ['xlsx', 'docx'])
    },
    {
      // No glob and no Excel/DOCX search: ripgrep's own hidden-file rule decides
      label: 'content search, no filePattern',
      args: { pattern: 'needle', searchType: 'content' },
      withoutHidden: matches(VISIBLE, ['txt']),
      withHidden: matches(ALL, ['txt'])
    },
    {
      // A hidden directory given as the path is searched
      label: 'content search in the hidden directory, filePattern "*.txt|*.xlsx|*.docx"',
      args: { path: path.join(TEST_DIR, 'attr-dir'), pattern: 'needle', searchType: 'content', filePattern: '*.txt|*.xlsx|*.docx' },
      withoutHidden: matches(IN_ATTR_HIDDEN_DIR, EXTENSIONS),
      withHidden: matches(IN_ATTR_HIDDEN_DIR, EXTENSIONS)
    },
    {
      // The glob lets attr-hidden.txt through; attr-dir's name does not match, so it is only entered with includeHidden
      label: 'file search, glob pattern "*.txt"',
      args: { pattern: '*.txt', searchType: 'files' },
      withoutHidden: files([...VISIBLE, ...ATTR_HIDDEN_FILES], ['txt']),
      withHidden: files(ALL, ['txt'])
    },
    {
      // "*" matches the name of attr-dir too, so it finds everything
      label: 'file search, glob pattern "*"',
      args: { pattern: '*', searchType: 'files' },
      withoutHidden: files(ALL, EXTENSIONS),
      withHidden: files(ALL, EXTENSIONS)
    },
    {
      // Becomes the glob "*attr*", which matches attr-hidden.* and attr-dir by their names
      // (attr-dir is entered, but the names of the files inside it don't match)
      label: 'file search, substring pattern "attr"',
      args: { pattern: 'attr', searchType: 'files' },
      withoutHidden: files(ATTR_HIDDEN_FILES, EXTENSIONS),
      withHidden: files(ATTR_HIDDEN_FILES, EXTENSIONS)
    },
  ];

  for (const { label, args, withoutHidden, withHidden } of cases) {
    for (const includeHidden of [false, true]) {
      const expected = sorted(includeHidden ? withHidden : withoutHidden);
      const actual = await runSearch({ contextLines: 0, ...args, includeHidden });
      assert.deepStrictEqual(actual, { totalMatches: expected.length, results: expected },
        `${label}, includeHidden: ${includeHidden}`);
    }
    console.log(`✓ ${label}: ${withoutHidden.length} results without hidden files, ${withHidden.length} with them`);
  }
}

export default async function runTests() {
  if (process.platform !== 'win32') {
    skip('Windows hidden attribute search tests: the hidden attribute exists on Windows only');
    return;
  }

  const originalConfig = await configManager.getConfig();
  await fs.rm(TEST_DIR, { recursive: true, force: true });
  await fs.mkdir(path.join(TEST_DIR, 'attr-dir'), { recursive: true });
  await configManager.setValue('allowedDirectories', [TEST_DIR]);
  try {
    for (const stem of [...VISIBLE, ...ATTR_HIDDEN_FILES, ...IN_ATTR_HIDDEN_DIR]) {
      const base = path.join(TEST_DIR, ...stem.split('/'));
      await fs.writeFile(`${base}.txt`, 'needle\n');
      // Real Office files, written by Desktop Commander's own Excel and DOCX handlers
      await writeFile(`${base}.xlsx`, JSON.stringify([['needle report']]));
      await writeFile(`${base}.docx`, 'needle report');
    }
    for (const stem of ATTR_HIDDEN_FILES) {
      for (const ext of EXTENSIONS) setHiddenAttribute(path.join(TEST_DIR, `${stem}.${ext}`));
    }
    setHiddenAttribute(path.join(TEST_DIR, 'attr-dir'));

    await testHiddenAttribute();
    console.log('✅ Windows hidden attribute search tests passed');
  } finally {
    // Stop any search still running (before its files are removed) and drop all sessions
    searchManager.dispose();
    await configManager.updateConfig(originalConfig);
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  }
}

runIfMain(import.meta.url, runTests);
