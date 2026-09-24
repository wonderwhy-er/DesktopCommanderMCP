/**
 * Tests searching when the bundled ripgrep can't be started (a corrupt or
 * wrong-platform download): start_search reports why - the reason ripgrep
 * could not start, for a file search and for a content search - and does not
 * crash the server; and searchFiles() (src/tools/filesystem.ts) falls back to
 * its Node.js walk. ripgrep can't be started in a child process
 * (fixtures/unusable-ripgrep-preload.mjs).
 * The fallback is the long-standing Node.js walk, which does not find the same
 * files as the search through ripgrep: it returns every file AND directory
 * whose name contains the pattern, ignoring case - hidden ones (names starting
 * with '.') included - and knows no globs ("*.txt" is taken literally).
 */

import assert from 'assert';
import path from 'path';
import fs from 'fs/promises';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { searchFiles } from '../dist/tools/filesystem.js';
import { searchManager } from '../dist/search-manager.js';
import { configManager } from '../dist/config-manager.js';
import { runIfMain } from './helpers/run-if-main.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, 'search-without-ripgrep-test');
const SEARCH_DIR = path.join(TEST_DIR, 'files');
// Where the child's @vscode/ripgrep says ripgrep is: a directory, which can't be started
const UNUSABLE_RIPGREP = path.join(TEST_DIR, process.platform === 'win32' ? 'rg.exe' : 'rg');
// Why: Windows looks for a file to run, and finds none; elsewhere a directory can't be executed
const START_ERROR = `Failed to start ripgrep: spawn ${UNUSABLE_RIPGREP} ${process.platform === 'win32' ? 'ENOENT' : 'EACCES'}`;

const FILES = [
  'notes.txt', 'Notes.MD', 'report-notes.txt', 'other.txt', 'sub/notes-2.txt', 'sub/deep/NOTES.csv',
  'notes-dir/inside.txt',  // A directory whose name matches "notes"
  '.notes-hidden.txt', 'visible/.notes.txt', '.hidden-dir/notes.txt'
];

// Each pattern, and the files searchFiles() returns for it through ripgrep, and through its Node.js fallback
const CASES = [
  // A substring, ignoring case: the glob "*notes*" for ripgrep, which lets the hidden files it
  // matches through (long-standing behavior); .hidden-dir's name does not match, so it is not entered.
  // The fallback also returns the directory notes-dir, and what is inside .hidden-dir
  ['notes',
    ['notes.txt', 'Notes.MD', 'report-notes.txt', 'sub/notes-2.txt', 'sub/deep/NOTES.csv', '.notes-hidden.txt', 'visible/.notes.txt'],
    ['notes.txt', 'Notes.MD', 'report-notes.txt', 'sub/notes-2.txt', 'sub/deep/NOTES.csv', '.notes-hidden.txt', 'visible/.notes.txt',
      'notes-dir', '.hidden-dir/notes.txt']],
  ['*.txt',
    ['notes.txt', 'report-notes.txt', 'other.txt', 'sub/notes-2.txt', 'notes-dir/inside.txt', '.notes-hidden.txt', 'visible/.notes.txt'],
    []],
  // An exact filename for ripgrep; a substring for the fallback
  ['notes.txt',
    ['notes.txt'],
    ['notes.txt', 'report-notes.txt', 'visible/.notes.txt', '.hidden-dir/notes.txt']],
  // A glob with '/' matches the path below the root: '*' does not cross a '/'
  ['sub/*', ['sub/notes-2.txt'], []],
  ['{notes,other}.txt', ['notes.txt', 'other.txt'], []],
];

async function testWithoutRipgrep() {
  console.log('Testing searches when ripgrep can\'t be started...');

  const root = await fs.realpath(SEARCH_DIR);
  const expectedFor = (rels) => rels.map((rel) => path.join(root, ...rel.split('/'))).sort();

  // Through ripgrep, in this process
  for (const [pattern, rels] of CASES) {
    assert.deepStrictEqual([...await searchFiles(SEARCH_DIR, pattern)].sort(), expectedFor(rels),
      `searchFiles("${pattern}") through ripgrep`);
  }
  console.log(`✓ searchFiles(): ${CASES.length} patterns through ripgrep`);

  // In a process where ripgrep can't be started
  const child = spawnSync(process.execPath, [
    '--import', pathToFileURL(path.join(__dirname, 'fixtures', 'unusable-ripgrep-preload.mjs')).href,
    path.join(__dirname, 'fixtures', 'search-without-ripgrep.mjs'),
    SEARCH_DIR, ...CASES.map(([pattern]) => pattern)
  ], { env: { ...process.env, DC_TEST_UNUSABLE_RIPGREP: UNUSABLE_RIPGREP }, encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(child.status, 0, `The process without ripgrep failed (${child.status}): ${child.stderr}`);
  const { fileSearch, contentSearch, results } = JSON.parse(child.stdout.trim().split('\n').pop());

  const reported = { isError: true, text: `Error starting search session: ${START_ERROR}` };
  assert.deepStrictEqual(fileSearch, reported, 'start_search (a file search) should report why ripgrep could not start');
  assert.deepStrictEqual(contentSearch, reported,
    'start_search (a content search) should report why ripgrep could not start');
  console.log(`✓ start_search reports "${START_ERROR}"`);

  for (const [pattern, , fallbackRels] of CASES) {
    assert.deepStrictEqual([...results[pattern]].sort(), expectedFor(fallbackRels), `searchFiles("${pattern}") through the Node.js fallback`);
  }
  console.log(`✓ searchFiles(): ${CASES.length} patterns through the Node.js fallback`);
}

export default async function runTests() {
  const originalConfig = await configManager.getConfig();
  await fs.rm(TEST_DIR, { recursive: true, force: true });
  await fs.mkdir(UNUSABLE_RIPGREP, { recursive: true });
  await configManager.setValue('allowedDirectories', [SEARCH_DIR]);
  try {
    for (const rel of FILES) {
      const file = path.join(SEARCH_DIR, ...rel.split('/'));
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, 'content');
    }
    await testWithoutRipgrep();
    console.log('✅ Search without ripgrep tests passed');
  } finally {
    // Stop any search still running (before its files are removed) and drop all sessions
    searchManager.dispose();
    await configManager.updateConfig(originalConfig);
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  }
}

runIfMain(import.meta.url, runTests);
