/**
 * read_file counts a file's lines the way it reads them: a line ends at LF,
 * CRLF or a lone CR (as readline splits them).
 *
 * The user's symptom: a 50-line file with lone-CR line breaks was read as 50
 * lines, but the status line said "(total: 1 lines, 0 remaining)", and
 * get_file_info said lineCount 1: the total counted LF characters only.
 * Over 10 MB (no total shown), the tail and deep-offset reads find their
 * lines by the same rule; those cases guard it.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { handleReadFile, handleGetFileInfo } from '../dist/handlers/filesystem-handlers.js';
import { runIfMain } from './helpers/run-if-main.js';

// Over the 10 MB where read_file switches to its large-file paths
const LARGE = 10.5 * 1024 * 1024;

/** The "[Reading N lines ...]" status line and the lines after it */
function readLines(result) {
  const text = result.content[0].text;
  const at = text.indexOf('\n\n');
  return { status: text.slice(0, at), lines: text.slice(at + 2).split('\n') };
}

const numbered = (count) => Array.from({ length: count }, (_, i) => `line ${i + 1}`);

export default async function runTests() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-line-breaks-'));
  const failures = [];
  const check = (condition, message) => {
    console.log(`${condition ? '✅' : '❌'} ${message}`);
    if (!condition) failures.push(message);
  };

  try {
    // Under 10 MB: the status line's total and get_file_info's lineCount
    const lone = path.join(dir, 'lone-cr.txt');
    fs.writeFileSync(lone, numbered(50).join('\r'));
    const first10 = readLines(await handleReadFile({ path: lone, offset: 0, length: 10 }));
    check(
      first10.lines.length === 10 && first10.status === '[Reading 10 lines from start (total: 50 lines, 40 remaining)]',
      `a 50-line file with lone-CR line breaks: 10 lines read, total 50, got ${first10.lines.length} lines under "${first10.status}"`
    );
    const info = (await handleGetFileInfo({ path: lone })).content[0].text;
    const lineCount = (info.match(/^lineCount: (\d+)$/m) ?? [])[1];
    check(lineCount === '50', `get_file_info on it says lineCount 50, got ${lineCount}`);

    // Every kind of line break, and a final one: the total is the number of lines a full read returns
    const mixed = path.join(dir, 'mixed.txt');
    fs.writeFileSync(mixed, 'lf\ncrlf\r\ncr\rblank next\n\nlast\r');
    const all = readLines(await handleReadFile({ path: mixed, offset: 0, length: 100 }));
    check(
      all.lines.length === 6 && all.status === '[Reading 6 lines from start (total: 6 lines, 0 remaining)]',
      `LF, CRLF, lone CR, an empty line and a final CR: 6 lines read, total 6, got ${all.lines.length} lines under "${all.status}"`
    );

    // Over 10 MB: the last lines and a deep offset of a lone-CR file
    const big = path.join(dir, 'lone-cr-large.txt');
    const bigLines = [];
    for (let size = 0; size < LARGE; size += 100) bigLines.push(`line ${bigLines.length + 1}`.padEnd(99, '.'));
    fs.writeFileSync(big, bigLines.join('\r') + '\r');
    const tail = readLines(await handleReadFile({ path: big, offset: -3 }));
    check(
      JSON.stringify(tail.lines) === JSON.stringify(bigLines.slice(-3)),
      `offset -3 on a ${fs.statSync(big).size}-byte lone-CR file returns its last 3 lines, got ${JSON.stringify(tail.lines.map((l) => l.slice(0, 12)))} (${tail.status})`
    );
    const deep = readLines(await handleReadFile({ path: big, offset: 5000, length: 2 }));
    check(
      JSON.stringify(deep.lines) === JSON.stringify(bigLines.slice(5000, 5002)),
      `offset 5000 length 2 on it returns lines 5001-5002, got ${JSON.stringify(deep.lines.map((l) => l.slice(0, 12)))} (${deep.status})`
    );
  } catch (error) {
    check(false, `unexpected error: ${error.stack ?? error}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return failures.length === 0;
}

runIfMain(import.meta.url, runTests);
