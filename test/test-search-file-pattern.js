/**
 * Tests which files a content search's filePattern selects - the long-standing
 * behavior - for ripgrep (text files) and the Excel and DOCX searches that run
 * alongside it. filePattern is a "|"-separated list of globs. ripgrep matches
 * them as its globs: case-sensitively (ignoreCase does not apply to them),
 * "*", "?", "[...]" and "{a,b}" work, a glob with a "/" matches the path below
 * the search root, and "!" leaves files out. The Excel and DOCX searches match
 * each alternative against file names ignoring case, with "*" as the only
 * wildcard; a "!" alternative leaves files out for them too (with a "/", by the
 * path below the search root). The fixture holds each file name as a text, an
 * Excel and a DOCX file.
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
const TEST_DIR = path.join(__dirname, 'search-file-pattern-test');

// Each stem is written as <stem>.<ext> for every extension below (Shout with
// the extension in upper case). Text files hold 'needle', Office files 'needle report'.
const STEMS = ['notes', 'secret', 'Shout', 'sub/deep'];
const extensionsOf = (stem) => (stem === 'Shout' ? ['TXT', 'XLSX', 'DOCX'] : ['txt', 'xlsx', 'docx']);

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

async function testFilePatternSelection() {
  console.log('Testing which text, Excel and DOCX files a filePattern selects...');

  const root = await fs.realpath(TEST_DIR);
  const full = (rel) => path.join(root, ...rel.split('/'));
  // The matches ripgrep reports for the text files of textStems, and the Excel
  // and DOCX searches for the Office files of officeStems
  const matchesOf = (textStems, officeStems) => [
    ...textStems.map((stem) => ({ file: full(`${stem}.${extensionsOf(stem)[0]}`), line: 1, match: 'needle', type: 'content' })),
    ...officeStems.flatMap((stem) => {
      const [, xlsx, docx] = extensionsOf(stem).map((ext) => full(`${stem}.${ext}`));
      return [
        { file: `${xlsx}:Sheet1!Row1`, line: 1, match: 'needle report', type: 'content' },
        { file: docx, line: 1, match: 'needle report', type: 'content' }
      ];
    })
  ].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  // The long-standing behavior: ignoreCase does not apply to filePattern, so each
  // case selects the same files either way - ripgrep matches its globs case-sensitively,
  // the Excel/DOCX searches match names ignoring case
  const cases = [
    {
      // "*.txt" does not match Shout.TXT for ripgrep
      label: '"!" leaves files out',
      filePattern: '*.txt|*.xlsx|*.docx|!secret*',
      text: ['notes', 'sub/deep'],
      office: ['notes', 'Shout', 'sub/deep']
    },
    {
      label: 'upper-case globs',
      filePattern: '*.TXT|*.XLSX|*.DOCX',
      text: ['Shout'],
      office: ['notes', 'secret', 'Shout', 'sub/deep']
    },
    {
      // The Excel/DOCX searches match the alternatives against file names only
      label: 'a glob with "/" matches the path below the search root (ripgrep only)',
      filePattern: 'sub/*.txt|sub/*.xlsx|sub/*.docx',
      text: ['sub/deep'],
      office: []
    },
    {
      // A "!" glob leaves the files out for every source: with a "/", by their path below the search root
      label: 'a "!" glob with "/" leaves a directory\'s files out',
      filePattern: '*.txt|*.xlsx|*.docx|!sub/*',
      text: ['notes', 'secret'],
      office: ['notes', 'secret', 'Shout']
    },
    {
      // A "!" glob that matches a directory's name leaves out everything in it, for every source
      label: 'a "!" glob that matches a directory leaves its files out',
      filePattern: '*.txt|*.xlsx|*.docx|!sub',
      text: ['notes', 'secret'],
      office: ['notes', 'secret', 'Shout']
    },
    {
      // [ns] matches the first letter, each ? one more: "notes" and "Shout" have five letters, "secret" six.
      // The Excel/DOCX searches know no wildcard but '*': the alternatives are exact names to them
      label: '"[...]" and "?" (ripgrep only)',
      filePattern: '[ns]????.txt|[ns]????.xlsx|[ns]????.docx',
      text: ['notes'],
      office: []
    },
    {
      // The Excel/DOCX searches know no wildcard but '*': the alternatives are exact names to them
      label: '"{a,b}" (ripgrep only)',
      filePattern: '{notes,Shout}.txt|{notes,Shout}.xlsx|{notes,Shout}.docx',
      text: ['notes'],
      office: []
    },
    {
      // Exact names, the Excel one not last: the Excel search must run all the same
      label: 'exact file names',
      filePattern: 'notes.xlsx|notes.docx|notes.txt',
      text: ['notes'],
      office: ['notes']
    },
  ];

  for (const { label, filePattern, text, office } of cases) {
    const expected = matchesOf(text, office);
    for (const ignoreCase of [true, false]) {
      const actual = await runSearch({ pattern: 'needle', searchType: 'content', filePattern, ignoreCase, contextLines: 0 });
      assert.deepStrictEqual(actual, { totalMatches: expected.length, results: expected },
        `${label}: filePattern "${filePattern}", ignoreCase: ${ignoreCase}`);
    }
    console.log(`✓ ${label} ("${filePattern}"): text files ${text.join(', ') || 'none'}; ` +
      `Excel/DOCX files ${office.join(', ') || 'none'}`);
  }
}

export default async function runTests() {
  const originalConfig = await configManager.getConfig();
  await fs.rm(TEST_DIR, { recursive: true, force: true });
  await fs.mkdir(path.join(TEST_DIR, 'sub'), { recursive: true });
  await configManager.setValue('allowedDirectories', [TEST_DIR]);
  try {
    for (const stem of STEMS) {
      const [txt, xlsx, docx] = extensionsOf(stem).map((ext) => path.join(TEST_DIR, ...`${stem}.${ext}`.split('/')));
      await fs.writeFile(txt, 'needle\n');
      // Real Office files, written by Desktop Commander's own Excel and DOCX handlers
      await writeFile(xlsx, JSON.stringify([['needle report']]));
      await writeFile(docx, 'needle report');
    }

    await testFilePatternSelection();
    console.log('✅ filePattern tests passed');
  } finally {
    // Stop any search still running (before its files are removed) and drop all sessions
    searchManager.dispose();
    await configManager.updateConfig(originalConfig);
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  }
}

runIfMain(import.meta.url, runTests);
