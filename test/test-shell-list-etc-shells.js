/**
 * The shells Desktop Commander offers (the config editor's choices, from
 * detectAvailableShells()) are command shells only.
 *
 * /etc/shells lists login shells, and on Linux installing tmux or screen adds
 * them there; git-shell and nologin can be listed too. Each was offered as a
 * shell, and a command through it runs as `<program> -c "<command>"`, which
 * these programs don't honor. The test lists stand-ins with those names in
 * /etc/shells (read through a stub) next to a real shell.
 *
 * Top-level script, macOS/Linux only (Windows has no /etc/shells); nothing
 * outside a temporary folder is touched.
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { detectAvailableShells } from '../dist/utils/shell.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

const NOT_SHELLS = ['tmux', 'screen', 'git-shell', 'nologin', 'false'];

async function runTests() {
  if (process.platform === 'win32') {
    skip('/etc/shells filtering: Windows has no /etc/shells');
    return true;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-etc-shells-'));
  const standIns = NOT_SHELLS.map((name) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    return file;
  });
  const etcShells = ['# /etc/shells: valid login shells', '/bin/sh', ...standIns, ''].join('\n');

  const fsModule = (await import('fs')).default;
  const readFileSync = fsModule.readFileSync;
  fsModule.readFileSync = (file, ...rest) =>
    file === '/etc/shells' ? etcShells : readFileSync.call(fsModule, file, ...rest);
  let shells;
  try {
    shells = detectAvailableShells();
  } finally {
    fsModule.readFileSync = readFileSync;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const offered = standIns.filter((file) => shells.includes(file)).map((file) => path.basename(file));
  assert.deepStrictEqual(offered, [],
    `programs that aren't command shells were offered as shells: ${offered.join(', ')} (all: ${shells.join(', ')})`);
  assert.ok(shells.includes('/bin/sh'), `/bin/sh from /etc/shells should still be offered, got: ${shells.join(', ')}`);
  console.log(`✓ only command shells are offered from /etc/shells: ${shells.join(', ')}`);
}

runIfMain(import.meta.url, runTests);
