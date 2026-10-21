import assert from 'assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { getShellSpawnArgs, resolveShellPath } from '../dist/utils/shell.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

async function runTests() {
  if (process.platform !== 'win32') return skip('Windows-only direct shell spawn regression');

  const powershell = resolveShellPath('powershell.exe');
  if (!powershell) return skip('powershell.exe is not available');

  const direct = getShellSpawnArgs('powershell.exe', 'powershell -NoProfile -NoLogo');
  assert.deepStrictEqual(direct.args, ['-NoProfile', '-NoLogo']);
  assert.strictEqual(direct.useShellOption, false);

  const directExe = getShellSpawnArgs('powershell.exe', 'powershell.exe -NoProfile');
  assert.deepStrictEqual(directExe.args, ['-NoProfile']);

  const directResolvedPath = getShellSpawnArgs('powershell.exe', `${powershell} -NoLogo`);
  assert.deepStrictEqual(directResolvedPath.args, ['-NoLogo'],
    'the exact configured executable path may use the direct path');

  const quoted = getShellSpawnArgs('powershell.exe', 'powershell -Command "Write-Output hello"');
  assert.deepStrictEqual(quoted.args, ['-Command', 'powershell -Command "Write-Output hello"'],
    'quoted commands stay on the existing wrapper path');

  const metachar = getShellSpawnArgs('powershell.exe', 'powershell; Write-Output hello');
  assert.deepStrictEqual(metachar.args, ['-Command', 'powershell; Write-Output hello'],
    'shell metacharacters stay on the existing wrapper path');

  const multiline = getShellSpawnArgs('powershell.exe', 'powershell\n-NoProfile');
  assert.deepStrictEqual(multiline.args, ['-Command', 'powershell\n-NoProfile'],
    'multiline commands stay on the wrapper path instead of becoming direct arguments');

  const multilineCrLf = getShellSpawnArgs('powershell.exe', 'powershell\r\n-NoLogo');
  assert.deepStrictEqual(multilineCrLf.args, ['-Command', 'powershell\r\n-NoLogo'],
    'CRLF multiline commands preserve wrapper parsing semantics');

  const otherShell = getShellSpawnArgs('powershell.exe', 'cmd /Q');
  assert.deepStrictEqual(otherShell.args, ['-Command', 'cmd /Q'],
    'a different shell is not reinterpreted by the direct path');

  const fakeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc443-shell-'));
  const fakePowerShell = path.join(fakeDir, 'powershell.exe');
  try {
    await fs.writeFile(fakePowerShell, 'not-an-executable');
    const alternatePath = getShellSpawnArgs('powershell.exe', `${fakePowerShell} -NoProfile`);
    assert.deepStrictEqual(alternatePath.args, ['-Command', `${fakePowerShell} -NoProfile`],
      'a different same-basename executable must not be replaced by the configured shell');
  } finally {
    await fs.rm(fakeDir, { recursive: true, force: true });
  }

  const cmd = resolveShellPath('cmd.exe');
  if (cmd) {
    const directCmd = getShellSpawnArgs('cmd.exe', 'cmd /Q');
    assert.deepStrictEqual(directCmd.args, ['/Q']);
    assert.strictEqual(directCmd.windowsVerbatim, true);
  }

  console.log('PASS: simple same-shell invocations are direct while ambiguous commands preserve wrapper behavior');
  return true;
}

runIfMain(import.meta.url, runTests);
