/**
 * Tests which files a content search's filePattern selects - the long-standing
 * behavior - for ripgrep (text files) and the Excel and DOCX searches that run
 * alongside it. filePattern is a "|"-separated list of globs. ripgrep matches
 * them as its globs: case-sensitively (ignoreCase does not apply to them),
 * "*", "?", "[...]" and "{a,b}" work, a glob with a "/" matches the path below
 * the search root, and "!" leaves files out. The Excel and DOCX searches match
 * the same globs, ignoring case. A pattern of only "!" globs keeps every file
 * they don't leave out, and a file given as the search path is searched
 * whatever the pattern says, as ripgrep searches a file it is given. The
 * fixture holds each file name as a text, an Excel and a DOCX file.
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
      label: 'a glob with "/" matches the path below the search root',
      filePattern: 'sub/*.txt|sub/*.xlsx|sub/*.docx',
      text: ['sub/deep'],
      office: ['sub/deep']
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
      // The Excel/DOCX searches ignore case: "[ns]" matches Shout's "S", ".xlsx" its ".XLSX"
      label: '"[...]" and "?"',
      filePattern: '[ns]????.txt|[ns]????.xlsx|[ns]????.docx',
      text: ['notes'],
      office: ['notes', 'Shout']
    },
    {
      label: '"{a,b}"',
      filePattern: '{notes,Shout}.txt|{notes,Shout}.xlsx|{notes,Shout}.docx',
      text: ['notes'],
      office: ['notes', 'Shout']
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

async function testSearchPathIsAFile() {
  console.log('Testing a file given as the search path...');

  const root = await fs.realpath(TEST_DIR);
  const expectedMatch = {
    txt: (file) => ({ file, line: 1, match: 'needle', type: 'content' }),
    xlsx: (file) => ({ file: `${file}:Sheet1!Row1`, line: 1, match: 'needle report', type: 'content' }),
    docx: (file) => ({ file, line: 1, match: 'needle report', type: 'content' })
  };
  // Only "!" alternatives, one that selects other files, and one that matches
  // the file: ripgrep searches a file it is given whatever its globs say
  const notSearched = [];
  for (const filePattern of ['!*.tmp', '*.ts', '!notes*']) {
    for (const [ext, matchOf] of Object.entries(expectedMatch)) {
      const file = path.join(root, `notes.${ext}`);
      const actual = await runSearch({ path: file, pattern: 'needle', searchType: 'content', filePattern, contextLines: 0 });
      try {
        assert.deepStrictEqual(actual, { totalMatches: 1, results: [matchOf(file)] });
      } catch {
        notSearched.push(`notes.${ext} with "${filePattern}" (${actual.totalMatches} matches)`);
      }
    }
  }
  assert.deepStrictEqual(notSearched, [],
    `A file given as the search path should be searched whatever filePattern says, as ripgrep searches a file it is given; not searched: ${notSearched.join(', ')}`);
  console.log('✓ notes.txt, notes.xlsx and notes.docx, each given as the search path, are searched with "!*.tmp", "*.ts" and "!notes*"');
}

async function testOnlyExclusions() {
  console.log('Testing a filePattern of only "!" alternatives...');

  // A folder named like an Excel file: the Excel search runs for it (as for an
  // Excel file) with a filePattern that doesn't target Excel files
  const folder = path.join(TEST_DIR, 'book.xlsx');
  await fs.mkdir(folder);
  try {
    for (const stem of ['notes', 'secret']) {
      await writeFile(path.join(folder, `${stem}.xlsx`), JSON.stringify([['needle report']]));
    }
    const book = await fs.realpath(folder);
    const actual = await runSearch({ path: folder, pattern: 'needle', searchType: 'content', filePattern: '!secret*', contextLines: 0 });
    assert.deepStrictEqual(actual, {
      totalMatches: 1,
      results: [{ file: `${path.join(book, 'notes.xlsx')}:Sheet1!Row1`, line: 1, match: 'needle report', type: 'content' }]
    }, 'filePattern "!secret*" should leave secret.xlsx out and keep notes.xlsx, as ripgrep keeps every file its "!" globs don\'t leave out');
    console.log('✓ "!secret*": the Excel search keeps notes.xlsx and leaves secret.xlsx out');
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
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
    await testSearchPathIsAFile();
    await testOnlyExclusions();
    console.log('✅ filePattern tests passed');
  } finally {
    // Stop any search still running (before its files are removed) and drop all sessions
    searchManager.dispose();
    await configManager.updateConfig(originalConfig);
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  }
}

runIfMain(import.meta.url, runTests);
