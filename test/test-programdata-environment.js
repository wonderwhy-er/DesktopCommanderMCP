/**
 * Windows ProgramData regression for #702 / #627.
 * Scope: a missing variable and preservation of a normal existing value.
 * No system-wide environment variables or SSH configuration are changed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { terminalManager } from '../dist/terminal-manager.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

async function runTests() {
  if (process.platform !== 'win32') {
    skip('ProgramData and Windows OpenSSH require Windows');
    return true;
  }

  const original = Object.entries(process.env)
    .filter(([name]) => name.toLowerCase() === 'programdata');
  const execute = async (command) =>
    (await terminalManager.executeCommand(command, 10000, 'powershell.exe')).output;

  try {
    for (const [name] of original) delete process.env[name];

    const missing = await execute('Write-Output "DC_PROGRAMDATA=$env:ProgramData"');
    const expected = `${process.env.SystemDrive || 'C:'}\\ProgramData`;
    assert.ok(missing.includes(`DC_PROGRAMDATA=${expected}`),
      `missing ProgramData was not restored: ${JSON.stringify(missing)}`);

    const ssh = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
    if (fs.existsSync(ssh)) {
      const result = await execute(`& "${ssh}" -V; Write-Output "DC_SSH_EXIT=$LASTEXITCODE"`);
      assert.match(result, /DC_SSH_EXIT=0/,
        `native Windows OpenSSH did not recover: ${JSON.stringify(result)}`);
    } else {
      skip('Windows OpenSSH is not installed');
    }

    process.env.ProgramData = 'C:\\CustomProgramData';
    const retained = await execute('Write-Output "DC_PROGRAMDATA=$env:ProgramData"');
    assert.ok(retained.includes('DC_PROGRAMDATA=C:\\CustomProgramData'),
      `existing ProgramData was overwritten: ${JSON.stringify(retained)}`);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (key.toLowerCase() === 'programdata') delete process.env[key];
    }
    for (const [name, value] of original) {
      if (value !== undefined) process.env[name] = value;
    }
  }
  console.log('PASS: Windows ProgramData inheritance and OpenSSH');
  return true;
}

runIfMain(import.meta.url, runTests);
export default runTests;
