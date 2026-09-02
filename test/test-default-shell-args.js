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
import { getShellSpawnArgs } from '../dist/terminal-manager.js';
import assert from 'assert';

function runDefaultShellArgsTests() {
  // 1. Single-token values are unchanged (no regression)
  let cfg = getShellSpawnArgs('/bin/bash', 'echo hi');
  assert.strictEqual(cfg.executable, '/bin/bash');
  assert.deepStrictEqual(cfg.args, ['-l', '-c', 'echo hi']);
  console.log('✓ single-token /bin/bash unchanged');

  cfg = getShellSpawnArgs('pwsh.exe', 'x');
  assert.strictEqual(cfg.executable, 'pwsh.exe');
  assert.deepStrictEqual(cfg.args, ['-Login', '-Command', 'x']);
  console.log('✓ single-token pwsh.exe unchanged');

  // 2. The reported case: pwsh with flags no longer collapses into the executable
  cfg = getShellSpawnArgs('pwsh.exe -NoProfile -NoLogo', 'Write-Host hi');
  assert.strictEqual(cfg.executable, 'pwsh.exe');
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
  assert.strictEqual(cfg.executable, 'cmd.exe');
  assert.deepStrictEqual(cfg.args, ['/q', '/c', 'dir']);
  assert.strictEqual(cfg.windowsVerbatim, true);
  console.log('✓ cmd.exe /q splits correctly and stays verbatim');

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
