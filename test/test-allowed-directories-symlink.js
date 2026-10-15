/**
 * An allowed directory written through a symlink (a junction on Windows) is
 * the same directory as its target, so every path inside it must stay allowed.
 * validatePath resolves the requested path to its real path before the check;
 * the allowed directories have to be compared the same way. On macOS this is
 * the everyday case: os.tmpdir() is under /var, a symlink to /private/var.
 * An allowed directory whose real path never resolves (an unresponsive mount)
 * must not hold up paths inside the others: they were refused after the 10 s
 * validation timeout.
 *
 * Top-level script: runs on any runner and restores the original config.
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { configManager } from '../dist/config-manager.js';
import { validatePath } from '../dist/tools/filesystem.js';
import { runIfMain } from './helpers/run-if-main.js';

async function runTests() {
  const stamp = `${process.pid}-${Date.now()}`;
  const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-allowed-real-'));
  const linkDir = path.join(os.tmpdir(), `dc-allowed-link-${stamp}`);
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-allowed-outside-'));
  fs.writeFileSync(path.join(realDir, 'inside.txt'), 'inside');
  fs.writeFileSync(path.join(outsideDir, 'outside.txt'), 'outside');
  // 'junction' needs no admin rights on Windows; the type is ignored elsewhere
  fs.symlinkSync(realDir, linkDir, 'junction');

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

  try {
    console.log('Allowed directory written through a link');
    await configManager.setValue('allowedDirectories', [linkDir]);
    check('the link itself', await allowed(linkDir), true);
    check('a file inside, through the link', await allowed(path.join(linkDir, 'inside.txt')), true);
    check('a new file inside, through the link', await allowed(path.join(linkDir, 'new.txt')), true);
    check('the same file by its real path', await allowed(path.join(realDir, 'inside.txt')), true);
    check('a directory outside', await allowed(outsideDir), false);
    check('a file outside', await allowed(path.join(outsideDir, 'outside.txt')), false);

    console.log('Allowed directory written as the real path (control)');
    await configManager.setValue('allowedDirectories', [realDir]);
    check('a file inside, by its real path', await allowed(path.join(realDir, 'inside.txt')), true);
    check('a file outside', await allowed(path.join(outsideDir, 'outside.txt')), false);

    // An allowed directory on an unresponsive mount: resolving its real path
    // never finishes. Paths in the other allowed directories must not wait for it.
    console.log('Another allowed directory whose real path never resolves (an unresponsive mount)');
    const hungDir = path.join(os.tmpdir(), `dc-allowed-hung-${stamp}`);
    fs.mkdirSync(hungDir);
    await configManager.setValue('allowedDirectories', [hungDir, realDir]);
    const fsPromises = (await import('fs/promises')).default;
    const realpath = fsPromises.realpath;
    fsPromises.realpath = (p, ...rest) =>
      path.resolve(String(p)) === path.resolve(hungDir) ? new Promise(() => {}) : realpath.call(fsPromises, p, ...rest);
    try {
      check('a file inside the other allowed directory', await allowed(path.join(realDir, 'inside.txt')), true);
      check('a file outside every allowed directory', await allowed(path.join(outsideDir, 'outside.txt')), false);
    } finally {
      fsPromises.realpath = realpath;
      fs.rmSync(hungDir, { recursive: true, force: true });
    }
  } finally {
    await configManager.setValue('allowedDirectories', originalAllowed);
    try { fs.unlinkSync(linkDir); } catch { fs.rmdirSync(linkDir); }
    fs.rmSync(realDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }

  assert.strictEqual(failures, 0, `${failures} allowed-directory check(s) failed`);
  console.log('✅ Allowed directories behind a link keep their contents allowed');
}

runIfMain(import.meta.url, runTests);
