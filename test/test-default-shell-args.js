/**
 * Tests for defaultShell / shell values that carry arguments (issue #448).
 *
 * A defaultShell like "pwsh.exe -NoProfile -NoLogo" or "/bin/bash --norc" used to
 * be treated as a single executable path, so spawn failed with ENOENT and the
 * call hung until the client timed out. getShellSpawnArgs now splits the
 * executable from its arguments, matches the shell on the executable name and
 * keeps the caller's extra args ahead of the standard flags. Single-token values
 * must stay byte-for-byte identical to the old behaviour.
 *
 * These assertions are platform independent (shell matching for cmd/pwsh keys and
 * the POSIX paths used here resolve the same on any OS), so they run on macOS CI.
 */
import { getShellSpawnArgs } from '../dist/utils/shell.js';
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

function runDefaultShellArgsTests() {
  // 1. Single-token values are unchanged (no regression)
  let cfg = getShellSpawnArgs('/bin/bash', 'echo hi');
  assert.strictEqual(cfg.executable, '/bin/bash');
  assert.deepStrictEqual(cfg.args, ['-l', '-c', 'echo hi']);
  console.log('✓ single-token /bin/bash unchanged');

  cfg = getShellSpawnArgs('pwsh.exe', 'x');
  // getShellSpawnArgs resolves the executable, so on a host where pwsh.exe is on
  // PATH this is a full path, not the bare name. Compare the basename.
  assert.strictEqual(path.basename(cfg.executable).toLowerCase(), 'pwsh.exe');
  assert.deepStrictEqual(cfg.args, ['-Login', '-Command', 'x']);
  console.log('✓ single-token pwsh.exe unchanged');

  // 2. The reported case: pwsh with flags no longer collapses into the executable
  cfg = getShellSpawnArgs('pwsh.exe -NoProfile -NoLogo', 'Write-Host hi');
  assert.strictEqual(path.basename(cfg.executable).toLowerCase(), 'pwsh.exe');
  assert.deepStrictEqual(cfg.args, ['-NoProfile', '-NoLogo', '-Login', '-Command', 'Write-Host hi']);
  console.log('✓ pwsh.exe with flags splits correctly');

  // 3. Unix shell with a flag
  cfg = getShellSpawnArgs('/bin/bash --norc', 'echo hi');
  assert.strictEqual(cfg.executable, '/bin/bash');
  assert.deepStrictEqual(cfg.args, ['--norc', '-l', '-c', 'echo hi']);
  console.log('✓ /bin/bash --norc splits correctly');

  // 4. Quoted executable path with spaces survives
  cfg = getShellSpawnArgs('"/opt/my shell/bin/bash" --norc', 'echo hi');
  assert.strictEqual(cfg.executable, '/opt/my shell/bin/bash');
  assert.deepStrictEqual(cfg.args, ['--norc', '-l', '-c', 'echo hi']);
  console.log('✓ quoted executable path with spaces preserved');

  // 5. cmd with a flag keeps windowsVerbatim
  cfg = getShellSpawnArgs('cmd.exe /q', 'dir');
  assert.strictEqual(path.basename(cfg.executable).toLowerCase(), 'cmd.exe');
  assert.deepStrictEqual(cfg.args, ['/q', '/c', 'dir']);
  assert.strictEqual(cfg.windowsVerbatim, true);
  console.log('✓ cmd.exe /q splits correctly and stays verbatim');

  // 6. An unquoted path with spaces that exists is one executable, as before
  //    this change, not an executable plus arguments. Uses a self-contained
  //    executable fixture (named like bash so the bash branch is exercised)
  //    rather than depending on /bin/bash being present. POSIX only: the shebang
  //    fixture does not run on Windows.
  if (process.platform !== 'win32') {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-shell-args-'));
    try {
      const shellDir = path.join(tmp, 'My Shell', 'bin');
      fs.mkdirSync(shellDir, { recursive: true });
      const spacedBash = path.join(shellDir, 'bash');
      // ignores the -l -c flags getShellSpawnArgs adds and just prints hi
      fs.writeFileSync(spacedBash, '#!/bin/sh\necho hi\n');
      fs.chmodSync(spacedBash, 0o755);
      cfg = getShellSpawnArgs(spacedBash, 'echo hi');
      assert.strictEqual(cfg.executable, spacedBash);
      assert.deepStrictEqual(cfg.args, ['-l', '-c', 'echo hi']);
      const run = spawnSync(cfg.executable, cfg.args, { encoding: 'utf8' });
      assert.strictEqual(run.stdout.trim().split('\n').pop(), 'hi');
      console.log('✓ unquoted existing path with spaces kept whole');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // 7. Unknown shells keep their args instead of silently dropping them
  cfg = getShellSpawnArgs('/bin/sh -e', 'false; echo reached');
  assert.strictEqual(cfg.executable, '/bin/sh');
  assert.deepStrictEqual(cfg.args, ['-e', '-c', 'false; echo reached']);
  assert.strictEqual(cfg.useShellOption, false);
  if (fs.existsSync('/bin/sh')) {
    const run = spawnSync(cfg.executable, cfg.args, { encoding: 'utf8' });
    assert.notStrictEqual(run.status, 0);
    assert.strictEqual(run.stdout, '');
  }
  console.log('✓ unknown shell /bin/sh -e honours -e');

  // 8. Unknown shell without args keeps the old shell-option fallback
  cfg = getShellSpawnArgs('/bin/sh', 'echo hi');
  assert.strictEqual(cfg.executable, 'echo hi');
  assert.deepStrictEqual(cfg.args, []);
  assert.strictEqual(cfg.useShellOption, '/bin/sh');
  console.log('✓ single-token unknown shell unchanged');

  // 9. Quotes inside a token group and are stripped, like a shell
  cfg = getShellSpawnArgs('/bin/bash --rcfile="/tmp/a b" -O \'extglob\'', 'echo hi');
  assert.strictEqual(cfg.executable, '/bin/bash');
  assert.deepStrictEqual(cfg.args, ['--rcfile=/tmp/a b', '-O', 'extglob', '-l', '-c', 'echo hi']);
  console.log('✓ quotes mid-argument stay in one argument');

  console.log('\n✅ All defaultShell argument-parsing tests passed');
}

export default async function runTests() {
  try {
    runDefaultShellArgsTests();
    return true;
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    return false;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runDefaultShellArgsTests();
}
