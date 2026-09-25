/**
 * move_file moves and renames the entry it is given, as its description says
 * ("Move or rename files and directories"):
 * - a link (a symlink, or a junction on Windows) is moved as a link; the
 *   folder it points to stays where it is
 * - a rename that only changes letter case renames, on case-insensitive
 *   filesystems too (Windows, macOS)
 * - a file or a folder moves to another volume ("Can move files between
 *   directories"), where a rename can't go (EXDEV): it is copied, then the
 *   source is removed, as mv does. It failed with "EXDEV: cross-device link
 *   not permitted" and the source stayed. A copy that fails leaves the source
 *   as it was, removes what it wrote, and answers the error. The other volume
 *   is a real one on macOS (a RAM disk); everywhere the rename between two
 *   folders of the test is also made to fail with EXDEV, as it does across
 *   volumes (a second volume on Windows needs admin rights).
 *
 * Calls the tool's handler, so each case sees the answer the AI gets.
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { handleMoveFile } from '../dist/handlers/filesystem-handlers.js';
import { createLink } from './helpers/links.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

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

/**
 * Runs `run` while a rename between the folders `a` and `b` fails as it does
 * across volumes (EXDEV); every other rename works as usual
 */
async function asIfOtherVolumes(a, b, run) {
  const rename = fs.rename;
  const inside = (p, dir) => (path.resolve(p) + path.sep).startsWith(path.resolve(dir) + path.sep);
  fs.rename = async (from, to) => {
    if ((inside(from, a) && inside(to, b)) || (inside(from, b) && inside(to, a))) {
      throw Object.assign(new Error(`EXDEV: cross-device link not permitted, rename '${from}' -> '${to}'`),
        { code: 'EXDEV', errno: -18, syscall: 'rename', path: from, dest: to });
    }
    return rename(from, to);
  };
  try {
    return await run();
  } finally {
    fs.rename = rename;
  }
}

/** A folder with files at two levels; returns its layout ({ relative path: content }) */
async function makeTree(root) {
  const tree = { 'top.txt': 'top', [path.join('sub', 'inner.txt')]: 'inner', [path.join('sub', 'deeper', 'deep.txt')]: 'deep' };
  for (const [relative, content] of Object.entries(tree)) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content);
  }
  return tree;
}

async function checkMovedAcross(source, destination, what) {
  const tree = await makeTree(source);
  await fs.writeFile(`${source}.txt`, 'a file');

  let answer = text(await handleMoveFile({ source: `${source}.txt`, destination: `${destination}.txt` }));
  check(answer.startsWith('Successfully moved'), `move_file of a file to ${what} should succeed, got: ${answer}`);
  check(await fs.readFile(`${destination}.txt`, 'utf8') === 'a file', `the file should be at its destination on ${what}`);
  check(!(await exists(`${source}.txt`)), `the file should be gone from its source after the move to ${what}`);

  answer = text(await handleMoveFile({ source, destination }));
  check(answer.startsWith('Successfully moved'), `move_file of a folder to ${what} should succeed, got: ${answer}`);
  for (const [relative, content] of Object.entries(tree)) {
    const moved = await fs.readFile(path.join(destination, relative), 'utf8').catch(() => null);
    check(moved === content, `${relative} should be in the moved folder on ${what}, found: ${JSON.stringify(moved)}`);
  }
  check(!(await exists(source)), `the folder should be gone from its source after the move to ${what}`);
}

async function testMoveToAnotherVolume(dir) {
  // Real paths, as move_file renames them (macOS's temp folder is behind a link)
  const base = await fs.realpath(dir);
  const [here, there] = [path.join(base, 'volume-a'), path.join(base, 'volume-b')];
  await fs.mkdir(here);
  await fs.mkdir(there);
  await asIfOtherVolumes(here, there, () => checkMovedAcross(path.join(here, 'folder'), path.join(there, 'folder'), 'another volume'));
}

/**
 * Makes `file` unreadable until the returned function is called. Returns null
 * when this process can still read it: root ignores a file's mode.
 */
async function makeUnreadable(file) {
  if (process.platform !== 'win32') {
    await fs.chmod(file, 0o000);
    if (await fs.readFile(file).then(() => true, () => false)) {
      await fs.chmod(file, 0o644);
      return null;
    }
    return () => fs.chmod(file, 0o644);
  }
  // Windows: another process holds it open without sharing it
  const holder = spawn('powershell.exe', ['-NoProfile', '-Command',
    `$f = [IO.File]::Open('${file}', 'Open', 'ReadWrite', 'None'); Write-Output locked; Start-Sleep -Seconds 60; $f.Close()`]);
  await new Promise((resolve, reject) => {
    holder.on('error', reject);
    holder.stdout.on('data', (chunk) => { if (chunk.toString().includes('locked')) resolve(); });
  });
  return () => new Promise((resolve) => { holder.once('exit', resolve); holder.kill(); });
}

async function testFailedCopyToAnotherVolume(dir) {
  const base = await fs.realpath(dir);
  const [here, there] = [path.join(base, 'volume-c'), path.join(base, 'volume-d')];
  await fs.mkdir(here);
  await fs.mkdir(there);
  const source = path.join(here, 'folder');
  const tree = await makeTree(source);
  const release = await makeUnreadable(path.join(source, 'sub', 'inner.txt'));
  if (!release) {
    return skip('a copy to another volume that fails: this process can read a file with mode 000 (it runs as root), so the copy can\'t be made to fail');
  }
  let answer;
  try {
    answer = await asIfOtherVolumes(here, there, async () => text(await handleMoveFile({ source, destination: path.join(there, 'folder') })));
  } finally {
    await release();
  }
  check(answer.startsWith('Error:') && !answer.includes('EXDEV'), `a copy that fails should answer its error, got: ${answer}`);
  for (const [relative, content] of Object.entries(tree)) {
    check(await fs.readFile(path.join(source, relative), 'utf8') === content, `${relative} should still be in the source`);
  }
  const left = await fs.readdir(there);
  check(left.length === 0, `the failed copy should leave nothing on the other volume, found: ${JSON.stringify(left)}`);
}

async function testMoveToRealVolume(dir) {
  if (process.platform !== 'darwin') {
    skip('move_file to a real second volume: made only on macOS (a RAM disk); a second volume on Windows needs admin rights');
    return;
  }
  // A 10 MB RAM disk, its own volume
  const device = spawnSync('hdiutil', ['attach', '-nomount', 'ram://20480'], { encoding: 'utf8' }).stdout.trim();
  check(device.startsWith('/dev/disk'), `hdiutil should attach a RAM disk, got: ${JSON.stringify(device)}`);
  const name = `dc-move-test-${process.pid}`;
  try {
    const erase = spawnSync('diskutil', ['erasevolume', 'HFS+', name, device], { encoding: 'utf8' });
    check(erase.status === 0, `diskutil should format the RAM disk: ${erase.stderr}`);
    await checkMovedAcross(path.join(dir, 'to-ram-disk'), path.join('/Volumes', name, 'folder'), 'a RAM disk');
  } finally {
    spawnSync('hdiutil', ['detach', device, '-force']);
  }
}

const CASES = [
  ['a link is moved, not the folder it points to', testLinkIsMovedNotItsTarget],
  ['a rename that only changes letter case renames', testCaseOnlyRename],
  ['a file and a folder move to another volume', testMoveToAnotherVolume],
  ['a copy to another volume that fails leaves the source and nothing on the other volume', testFailedCopyToAnotherVolume],
  ['a file and a folder move to a real second volume', testMoveToRealVolume],
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
