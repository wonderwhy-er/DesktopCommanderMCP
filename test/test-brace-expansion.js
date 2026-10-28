/**
 * braceWords(), the brace expansion the command check's POSIX reader uses for
 * a command name: bash turns {sudo,ls} into the words "sudo ls" before it runs
 * the command. The expected words are bash 5's, measured with Git Bash 5.3
 * (splitting words with `set --` only); macOS's bash 3.2 has no step and no
 * zero padding. The commands whose name is built this way are in the
 * corpus's expansion group (fixtures/command-check-corpus.mjs).
 *
 * Parse-only: nothing here runs a shell or a process.
 */
import assert from 'assert';
import { braceWords, unquotedChars } from '../dist/utils/brace-expansion.js';
import { runIfMain } from './helpers/run-if-main.js';

// A word as written outside quotes, and the words bash makes of it (empty ones dropped)
const WORDS = [
  ['{sudo,ls}', ['sudo', 'ls']],
  ['{,sudo}', ['sudo']],
  ['s{u,}do', ['sudo', 'sdo']],
  ['{s{u,x}do,ls}', ['sudo', 'sxdo', 'ls']],
  ['file{,.bak}', ['file', 'file.bak']],
  ['{,}', []],
  ['su{d..d}o', ['sudo']],
  ['x{01..03}', ['x01', 'x02', 'x03']],
  ['{1..10..3}', ['1', '4', '7', '10']],
  ['{-02..2}', ['-02', '-01', '000', '001', '002']],
  ['su{d..d..+1}o', ['sudo']],
  ['{1..5..+2}', ['1', '3', '5']],
  ['{a..e..+2}', ['a', 'c', 'e']],
  ['{+01..3}', ['1', '2', '3']],
  ['{+1..05}', ['01', '02', '03', '04', '05']],
  ['{+5..-02}', ['005', '004', '003', '002', '001', '000', '-01', '-02']],
  ['{1..3..++1}', ['{1..3..++1}']],
  ['{+a..c}', ['{+a..c}']],
  ['{z..x}', ['z', 'y', 'x']],
  ['{Z..b}', ['Z', '[', ']', '^', '_', '`', 'a', 'b']],
  ['a{b,c}d{e,f}', ['abde', 'abdf', 'acde', 'acdf']],
  ['{a,b}{,}', ['a', 'a', 'b', 'b']],
  ['{a{b,c}}', ['{ab}', '{ac}']],
  ['{a}{b,c}', ['{a}b', '{a}c']],
  ['{{a,b}', ['{a', '{b']],
  ['}{a,b}{', ['}a{', '}b{']],
  ['{su\\,do,ls}', ['su,do', 'ls']],
  ['\\{sudo,ls}', ['{sudo,ls}']],
  ['{sudo}', ['{sudo}']],
  ['{sudo..x}', ['{sudo..x}']],
  ['pre{}post', ['pre{}post']],
];

export default async function runTests() {
  const failures = [];

  for (const [word, want] of WORDS) {
    const got = braceWords(unquotedChars(word));
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      failures.push(`braceWords(${word}) should be ${JSON.stringify(want)} but was ${JSON.stringify(got)}`);
    }
  }

  if (failures.length > 0) {
    console.log(`\n${failures.length} brace expansion checks wrong:`);
    for (const f of failures) console.log(`  ✗ ${f}`);
  } else {
    console.log('\nAll brace expansion checks right');
  }
  assert.deepStrictEqual(failures, [], `${failures.length} brace expansion checks are wrong`);
  return true;
}

runIfMain(import.meta.url, runTests);
