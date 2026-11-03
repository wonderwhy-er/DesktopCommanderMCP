/**
 * An allowed drive root (D:\ or D:/) allows every path on that drive and
 * nothing on another, whatever the letter: what counts is the drive the user
 * allowed, not the one Windows is on. A drive other than the temporary
 * folder's is made with `subst` (built in, no admin rights) over a temporary
 * folder. subst's drive resolves to that folder, so the drive is also checked
 * as a separate volume sees it: real paths that keep their drive letter
 * (fs.realpath stubbed for that drive only).
 *
 * Windows only. Top-level script: runs on any runner and restores the config.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { configManager } from '../dist/config-manager.js';
import { validatePath } from '../dist/tools/filesystem.js';
import { createTempDir } from './helpers/test-env.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

/** A drive letter nothing is mapped to, from the end of the alphabet */
const freeDriveLetter = () => 'ZYXWVUTSRQPONMLKJIHGFED'.split('').find((letter) => !fs.existsSync(`${letter}:\\`));

async function runTests() {
  if (process.platform !== 'win32') return skip('drive letters: Windows only');
  const letter = freeDriveLetter();
  if (!letter) return skip('drive letters: no free drive letter for subst');

  const drive = `${letter}:`;
  const folder = createTempDir('dc-allowed-drive-');
  const outsideDir = createTempDir('dc-allowed-drive-outside-');
  fs.writeFileSync(path.join(folder, 'inside.txt'), 'inside');
  const outsideFile = path.join(outsideDir, 'outside.txt');
  fs.writeFileSync(outsideFile, 'outside');
  // The drive the temporary folders are on (the system drive, usually)
  const otherRoot = path.parse(outsideDir).root;

  async function allowed(p) {
    try {
      await validatePath(p);
      return true;
    } catch {
      return false;
    }
  }

  const originalAllowed = await configManager.getValue('allowedDirectories');
  let failures = 0;
  function check(name, actual, expected) {
    if (actual === expected) {
      console.log(`✓ ${name}`);
    } else {
      failures++;
      console.error(`✗ ${name}: expected ${expected ? 'allowed' : 'denied'}, got ${actual ? 'allowed' : 'denied'}`);
    }
  }

  async function checkDrive(allowedRoot) {
    await configManager.setValue('allowedDirectories', [allowedRoot]);
    check(`${allowedRoot} allowed: a file on ${drive}`, await allowed(`${drive}\\inside.txt`), true);
    check(`${allowedRoot} allowed: a new file on ${drive}`, await allowed(`${drive}\\new.txt`), true);
    check(`${allowedRoot} allowed: the drive root itself`, await allowed(`${drive}\\`), true);
    check(`${allowedRoot} allowed: a file on ${otherRoot}`, await allowed(outsideFile), false);
  }

  execFileSync('subst', [drive, folder]);
  const fsPromises = (await import('fs/promises')).default;
  const realpath = fsPromises.realpath;
  try {
    console.log(`${drive} as subst maps it (its real paths are in ${folder})`);
    await checkDrive(`${drive}\\`);

    console.log(`${drive} as a separate volume (real paths keep the drive letter)`);
    const onDrive = (p) => path.resolve(String(p)).toLowerCase().startsWith(`${drive.toLowerCase()}\\`);
    fsPromises.realpath = (p, ...rest) =>
      onDrive(p) ? Promise.resolve(path.resolve(String(p))) : realpath.call(fsPromises, p, ...rest);
    await checkDrive(`${drive}\\`);
    await checkDrive(`${drive}/`);

    console.log(`${otherRoot} still allows its own drive`);
    await configManager.setValue('allowedDirectories', [otherRoot]);
    check(`${otherRoot} allowed: a file on it`, await allowed(outsideFile), true);
    check(`${otherRoot} allowed: a file on ${drive}`, await allowed(`${drive}\\inside.txt`), false);
  } finally {
    fsPromises.realpath = realpath;
    await configManager.setValue('allowedDirectories', originalAllowed);
    execFileSync('subst', [drive, '/D']);
    fs.rmSync(folder, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }

  assert.strictEqual(failures, 0, `${failures} drive check(s) failed`);
  console.log('✅ An allowed drive root allows that whole drive and nothing else, whatever its letter');
}

runIfMain(import.meta.url, runTests);
