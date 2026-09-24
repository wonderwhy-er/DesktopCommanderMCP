/**
 * move_file moves and renames the entry it is given, as its description says
 * ("Move or rename files and directories"):
 * - a link (a symlink, or a junction on Windows) is moved as a link; the
 *   folder it points to stays where it is
 * - a rename that only changes letter case renames, on case-insensitive
 *   filesystems too (Windows, macOS)
 *
 * Calls the tool's handler, so each case sees the answer the AI gets.
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { handleMoveFile } from '../dist/handlers/filesystem-handlers.js';
import { createLink } from './helpers/links.js';
import { runIfMain } from './helpers/run-if-main.js';

const text = (result) => result.content.map((c) => c.text).join('\n');
const exists = (p) => fs.lstat(p).then(() => true, () => false);

function check(ok, message) {
  if (!ok) throw new Error(message);
}

async function testLinkIsMovedNotItsTarget(dir) {
  const folder = path.join(dir, 'folder');
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'x.txt'), 'x');
  const link = path.join(dir, 'link');
  await createLink(folder, link);
  const renamed = path.join(dir, 'renamed');

  const answer = text(await handleMoveFile({ source: link, destination: renamed }));
  check(answer.startsWith('Successfully moved'), `move_file of a link should succeed, got: ${answer}`);
  check(await exists(path.join(folder, 'x.txt')),
    'move_file of a link moved the folder it points to; the link should move and the folder stay');
  check((await fs.lstat(renamed)).isSymbolicLink(), 'the moved entry should still be a link');
  check(!(await exists(link)), 'the link should no longer be at its old path');
  check(await fs.realpath(renamed) === await fs.realpath(folder), 'the moved link should still point to the folder');
}

async function testCaseOnlyRename(dir) {
  const d = path.join(dir, 'case');
  await fs.mkdir(d);
  await fs.writeFile(path.join(d, 'foo.txt'), 'x');

  const answer = text(await handleMoveFile({ source: path.join(d, 'foo.txt'), destination: path.join(d, 'Foo.txt') }));
  check(answer.startsWith('Successfully moved'), `the rename should succeed, got: ${answer}`);
  const names = await fs.readdir(d);
  check(names.length === 1 && names[0] === 'Foo.txt',
    `a rename that only changes letter case should rename foo.txt to Foo.txt, the folder holds: ${JSON.stringify(names)}`);
}

const CASES = [
  ['a link is moved, not the folder it points to', testLinkIsMovedNotItsTarget],
  ['a rename that only changes letter case renames', testCaseOnlyRename],
];

async function runTests() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-move-file-'));
  const failures = [];
  try {
    for (const [name, run] of CASES) {
      console.log(`\n--- ${name} ---`);
      try {
        await run(dir);
        console.log('ok');
      } catch (error) {
        failures.push(name);
        console.log(`❌ ${error.message}`);
      }
    }
  } finally {
    // Best-effort: a temp folder left behind is harmless
    await fs.rm(dir, { recursive: true, force: true });
  }
  console.log(failures.length === 0
    ? '\n✅ move_file tests passed'
    : `\n❌ ${failures.length} of ${CASES.length} failed: ${failures.join('; ')}`);
  return failures.length === 0;
}

runIfMain(import.meta.url, runTests);

export default runTests;
