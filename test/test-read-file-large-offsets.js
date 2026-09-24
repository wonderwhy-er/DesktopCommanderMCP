/**
 * read_file on text files over 10 MB returns the lines its offset names, as it
 * does on smaller files.
 *
 * Over 10 MB, read_file takes two shortcuts:
 * - a small negative offset (tail) reads the file backwards in 8 KB chunks;
 * - a positive offset past line 1000 jumps to a byte position.
 * The user's symptoms:
 * - `offset: -3` on a file ending in a newline returned 2 lines and an empty one;
 * - a character split by an 8 KB chunk boundary came back as U+FFFD;
 * - `offset: 5000, length: 3` on a file whose first 10 KB has short lines
 *   returned lines 1278-1280: the jump was estimated from the first 10 KB's
 *   average line length.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { handleReadFile } from '../dist/handlers/filesystem-handlers.js';
import { runIfMain } from './helpers/run-if-main.js';

// Over the 10 MB where read_file switches to its large-file paths
const LARGE = 10.5 * 1024 * 1024;

/** The "[Reading N lines ...]" status line and the lines after it */
function readLines(result) {
  const text = result.content[0].text;
  const at = text.indexOf('\n\n');
  return { status: text.slice(0, at), lines: text.slice(at + 2).split('\n') };
}

/** Numbered 99-byte lines (plus the line break) until the file is over LARGE */
function bulk(eol = '\n') {
  const lines = [];
  for (let i = 1; lines.length * 100 < LARGE; i++) lines.push(`line ${i}`.padEnd(99, '.'));
  return lines.map((line) => line + eol).join('');
}

/** 1200 short lines, then long ones: the first 10 KB says nothing about the rest */
function shortThenLong(eol) {
  const lines = [];
  for (let i = 1; i <= 1200; i++) lines.push(`L${i}`.padEnd(9, '.'));
  for (let i = 1201, size = 1200 * 10; size < LARGE; i++, size += 500) lines.push(`L${i}`.padEnd(499, '.'));
  return lines.join(eol);
}

export default async function runTests() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-large-offsets-'));
  const failures = [];
  const check = (condition, message) => {
    console.log(`${condition ? '✅' : '❌'} ${message}`);
    if (!condition) failures.push(message);
  };
  const same = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);
  const cut = (lines) => JSON.stringify(lines.map((line) => line.slice(0, 12)));

  try {
    // Tail of a file that ends in a newline
    const trailing = path.join(dir, 'trailing-newline.txt');
    const content = bulk();
    fs.writeFileSync(trailing, content);
    const last3 = content.split('\n').slice(-4, -1);
    const tail = readLines(await handleReadFile({ path: trailing, offset: -3 }));
    check(
      same(tail.lines, last3),
      `offset -3 on a ${fs.statSync(trailing).size}-byte file ending in a newline returns its last 3 lines, got ${cut(tail.lines)} (${tail.status})`
    );

    // Tail whose first line the 8 KB chunk boundary cuts in the middle of a 3-byte character
    // (no final newline, so only the cut character can go wrong)
    const euro = path.join(dir, 'multibyte.txt');
    const euroLines = ['€'.repeat(1000), '€'.repeat(1000), `${'€'.repeat(1000)}z`];
    const euroTailBytes = Buffer.from(euroLines.join('\n'));
    check(
      (euroTailBytes[euroTailBytes.length - 8192] & 0xc0) === 0x80,
      'setup: the byte 8 KB from the end is inside a character'
    );
    fs.writeFileSync(euro, bulk() + euroLines.join('\n'));
    const euroTail = readLines(await handleReadFile({ path: euro, offset: -3 }));
    check(
      same(euroTail.lines, euroLines),
      `offset -3 returns the last 3 lines' characters intact, got ${euroTail.lines.length} lines with ${euroTail.lines.join('').split('\uFFFD').length - 1} U+FFFD (${euroTail.status})`
    );

    // A deep offset, with each line ending the readline way: \n, \r\n and a lone \r
    for (const [name, eol] of [['LF', '\n'], ['CRLF', '\r\n'], ['CR', '\r']]) {
      const file = path.join(dir, `deep-${name}.txt`);
      fs.writeFileSync(file, shortThenLong(eol));
      const deep = readLines(await handleReadFile({ path: file, offset: 5000, length: 3 }));
      check(
        same(deep.lines, ['L5001', 'L5002', 'L5003'].map((line) => line.padEnd(499, '.'))),
        `${name}: offset 5000 length 3 on a ${fs.statSync(file).size}-byte file returns L5001-L5003, got ${cut(deep.lines)} (${deep.status})`
      );
    }
  } catch (error) {
    check(false, `unexpected error: ${error.stack ?? error}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return failures.length === 0;
}

runIfMain(import.meta.url, runTests);
