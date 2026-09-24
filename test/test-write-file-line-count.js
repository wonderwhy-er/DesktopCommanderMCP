/**
 * write_file's "(N lines)" is the number of lines written, counted the way
 * read_file reads them, and its performance note comes only "over"
 * fileWriteLineLimit lines, as its description says ("Files over 50 lines will
 * generate performance notes").
 *
 * The user's symptom: writing 50 lines that end in a newline answered "(51
 * lines)" with the performance tip, and read_file then said "total: 50
 * lines". The count was content.split('\n').length: the empty piece after the
 * final newline counted as a line, and lone-CR line breaks didn't count.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { configManager } from '../dist/config-manager.js';
import { handleWriteFile } from '../dist/handlers/filesystem-handlers.js';
import { runIfMain } from './helpers/run-if-main.js';

const numbered = (count) => Array.from({ length: count }, (_, i) => `line ${i + 1}`);

export default async function runTests() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-write-count-'));
  const failures = [];
  const check = (condition, message) => {
    console.log(`${condition ? '✅' : '❌'} ${message}`);
    if (!condition) failures.push(message);
  };
  const write = async (name, content) => {
    const file = path.join(dir, name);
    const text = (await handleWriteFile({ path: file, content, mode: 'rewrite' })).content[0].text;
    return text.replace(file, '<file>');
  };

  try {
    const limit = (await configManager.getConfig()).fileWriteLineLimit ?? 50;

    const atLimit = await write('at-limit.txt', numbered(limit).join('\n') + '\n');
    check(
      atLimit.includes(`(${limit} lines)`) && !atLimit.includes('Performance tip'),
      `${limit} lines ending in a newline: "(${limit} lines)" and no performance note, got ${JSON.stringify(atLimit.slice(0, 90))}`
    );

    const overLimit = await write('over-limit.txt', numbered(limit + 1).join('\n') + '\n');
    check(
      overLimit.includes(`(${limit + 1} lines)`) && overLimit.includes('Performance tip'),
      `${limit + 1} lines ending in a newline: "(${limit + 1} lines)" and the performance note, got ${JSON.stringify(overLimit.slice(0, 90))}`
    );

    const breaks = await write('breaks.txt', 'lf\ncrlf\r\ncr\rlast');
    check(breaks.includes('(4 lines)'), `LF, CRLF and lone-CR line breaks: "(4 lines)", got ${JSON.stringify(breaks.slice(0, 90))}`);
  } catch (error) {
    check(false, `unexpected error: ${error.stack ?? error}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return failures.length === 0;
}

runIfMain(import.meta.url, runTests);
