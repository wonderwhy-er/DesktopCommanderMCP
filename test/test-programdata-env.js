/**
 * Regression for Windows child process environments missing ProgramData.
 * Unit cases are platform-independent; Windows additionally probes native ssh.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { repairWindowsProgramData } from '../dist/utils/windows-env.js';
import { terminalManager } from '../dist/terminal-manager.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

export default async function runTests() {
  let count = 0;
  const check = (description, operation) => {
    operation();
    count++;
    console.log(`  ok ${count} - ${description}`);
  };

  check('uses SystemDrive when ProgramData was filtered', () => {
    const env = { SystemDrive: 'C:' };
    repairWindowsProgramData(env, { SystemDrive: 'D:' });
    assert.equal(env.ProgramData, 'D:\\ProgramData');
  });

  check('prefers an explicitly inherited ProgramData path', () => {
    const env = {};
    repairWindowsProgramData(env, { ProgramData: 'E:\\Shared Data', SystemDrive: 'C:' });
    assert.equal(env.ProgramData, 'E:\\Shared Data');
  });

  check('preserves an existing ProgramData value', () => {
    const env = { ProgramData: 'X:\\Custom' };
    repairWindowsProgramData(env, { SystemDrive: 'C:' });
    assert.deepEqual(env, { ProgramData: 'X:\\Custom' });
  });

  check('preserves an existing uppercase PROGRAMDATA value', () => {
    const env = { PROGRAMDATA: 'X:\\Custom' };
    repairWindowsProgramData(env, { SystemDrive: 'C:' });
    assert.deepEqual(env, { PROGRAMDATA: 'X:\\Custom' });
  });

  check('replaces empty uppercase key without creating duplicates', () => {
    const env = { PROGRAMDATA: '', Other: 'keep' };
    repairWindowsProgramData(env, { SystemDrive: 'C:' });
    assert.deepEqual(env, { Other: 'keep', ProgramData: 'C:\\ProgramData' });
  });

  check('reads parent variable case-insensitively', () => {
    const env = {};
    repairWindowsProgramData(env, { PROGRAMDATA: 'F:\\Common', SYSTEMDRIVE: 'C:' });
    assert.equal(env.ProgramData, 'F:\\Common');
  });

  check('falls back to SystemRoot drive when SystemDrive is absent', () => {
    const env = {};
    repairWindowsProgramData(env, { SystemRoot: 'G:\\Windows' });
    assert.equal(env.ProgramData, 'G:\\ProgramData');
  });

  check('does not guess a drive when parent has none', () => {
    const env = { SystemRoot: 'other' };
    repairWindowsProgramData(env, {});
    assert.deepEqual(env, { SystemRoot: 'other' });
  });

  check('does not use invalid SystemDrive values', () => {
    const env = {};
    repairWindowsProgramData(env, { SystemDrive: '\\\\server\\share' });
    assert.deepEqual(env, {});
  });

  check('does not alter the parent environment', () => {
    const parent = { SystemDrive: 'C:' };
    const before = { ...parent };
    repairWindowsProgramData({}, parent);
    assert.deepEqual(parent, before);
  });

  // A native Windows smoke test for the precise #702 symptom. An OpenSSH
  // version probe has no network side effects and needs no credentials.
  if (process.platform === 'win32') {
    const ssh = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
    if (existsSync(ssh)) {
      check('native OpenSSH -V works with the repaired child environment', () => {
        const env = { ...process.env };
        for (const key of Object.keys(env)) {
          if (key.toLowerCase() === 'programdata') delete env[key];
        }
        repairWindowsProgramData(env, {
          SystemDrive: process.env.SystemDrive ||
            process.env.SystemRoot?.match(/^[A-Za-z]:/)?.[0]
        });
        const result = spawnSync(ssh, ['-V'], { env, encoding: 'utf8', timeout: 5000 });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0,
          `OpenSSH -V failed: ${result.stderr || result.stdout || '(no output)'}`);
        assert.match((result.stderr || '') + (result.stdout || ''), /OpenSSH/i);
      });

      // Exercise the actual terminal-manager spawn path with ProgramData missing.
      const original = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key.toLowerCase() === 'programdata')
      );
      for (const key of Object.keys(original)) delete process.env[key];
      try {
        const result = await terminalManager.executeCommand(
          `"${ssh}" -V`, 10000, 'powershell.exe'
        );
        assert.match(result.output, /OpenSSH/i,
          `terminal-manager failed to restore ProgramData: ${JSON.stringify(result)}`);
        count++;
        console.log(`  ok ${count} - terminal-manager restores ProgramData end to end`);
      } finally {
        for (const [key, value] of Object.entries(original)) process.env[key] = value;
      }
    } else {
      skip('Windows OpenSSH is not installed; native ProgramData smoke test');
    }
  }

  console.log(`PASS: ${count} ProgramData environment checks`);
  return true;
}

runIfMain(import.meta.url, runTests);
