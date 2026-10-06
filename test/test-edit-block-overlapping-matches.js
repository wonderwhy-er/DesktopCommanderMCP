/**
 * edit_block's occurrence count is the number of replacements it makes.
 *
 * The user's symptom: a file with three "retry();" lines in a row, a two-line
 * old_string "retry();\nretry();\n" and expected_replacements 2: edit_block
 * answered with the edited preview (success), but only one replacement was
 * made. The count stepped one character past each match, so it counted the
 * overlapping second match; the replacement (split/join) can't replace
 * overlapping matches.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { handleEditBlock } from '../dist/handlers/edit-search-handlers.js';
import { runIfMain } from './helpers/run-if-main.js';

const THREE_RETRIES = 'start();\nretry();\nretry();\nretry();\ndone();\n';

export default async function runTests() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-edit-overlap-'));
  const failures = [];
  const check = (condition, message) => {
    console.log(`${condition ? '✅' : '❌'} ${message}`);
    if (!condition) failures.push(message);
  };

  try {
    const file = path.join(dir, 'retries.js');
    fs.writeFileSync(file, THREE_RETRIES);
    const two = await handleEditBlock({
      file_path: file,
      old_string: 'retry();\nretry();\n',
      new_string: 'retryTwice();\n',
      expected_replacements: 2,
    });
    const twoText = two.content[0].text;
    const afterTwo = fs.readFileSync(file, 'utf8');
    check(
      twoText.startsWith('Expected 2 occurrences but found 1') && afterTwo === THREE_RETRIES,
      `expected_replacements 2 where only 1 replacement is possible is refused and leaves the file alone, got ${JSON.stringify(twoText.slice(0, 80))}, file ${JSON.stringify(afterTwo)}`
    );

    fs.writeFileSync(file, THREE_RETRIES);
    const one = await handleEditBlock({
      file_path: file,
      old_string: 'retry();\nretry();\n',
      new_string: 'retryTwice();\n',
      expected_replacements: 1,
    });
    const afterOne = fs.readFileSync(file, 'utf8');
    check(
      one.content[0].text.startsWith('[Reading ') && afterOne === 'start();\nretryTwice();\nretry();\ndone();\n',
      `expected_replacements 1 (the 1 replacement possible) replaces the first match, got ${JSON.stringify(one.content[0].text.slice(0, 80))}, file ${JSON.stringify(afterOne)}`
    );
  } catch (error) {
    check(false, `unexpected error: ${error.stack ?? error}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return failures.length === 0;
}

runIfMain(import.meta.url, runTests);
