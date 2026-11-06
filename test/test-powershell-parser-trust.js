import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { configManager } from '../dist/config-manager.js';
import { startProcess } from '../dist/tools/improved-process-tools.js';
import { resolveShellPath } from '../dist/utils/shell.js';
import { readPowerShellCommands, runningPowerShellHelpers } from '../dist/utils/powershell-commands.js';
import { createTempDir, isTestHome, withEnv } from './helpers/test-env.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

const blockedToken = 'parser_trust_blocked_fixture';
const command = "Write-Output 'trusted parser fixture'";

async function refusedStart(shell) {
  const original = configManager.getConfig;
  configManager.getConfig = async () => ({ blockedCommands: [blockedToken], defaultShell: shell });
  try {
    const result = await startProcess({ command: blockedToken, shell, timeout_ms: 1000 });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.blocked, true);
    assert.ok(!JSON.stringify(result).includes('Process started with PID'));
    return result;
  } finally {
    configManager.getConfig = original;
  }
}

async function testActualUntrustedStartup(dir) {
  if (process.platform === 'win32') {
    skip('The actual executable marker fixture uses a POSIX script; Windows runs the spawn guard and native parser checks');
    return;
  }
  const executable = path.join(dir, 'pwsh');
  const parserMarker = path.join(dir, 'parser-started');
  const executionMarker = path.join(dir, 'execution-started');
  fs.writeFileSync(executable, `#!/bin/sh
case "$*" in
  *-EncodedCommand*) : > "$PARSER_TRUST_MARKER" ;;
  *) : > "$PARSER_TRUST_EXECUTION_MARKER" ;;
esac
exit 23
`, { mode: 0o700 });
  await withEnv({ PARSER_TRUST_MARKER: parserMarker, PARSER_TRUST_EXECUTION_MARKER: executionMarker }, async () => {
    const result = await refusedStart(executable);
    assert.equal(fs.existsSync(parserMarker), false, 'The caller-selected program must not start as the parser before refusal');
    assert.equal(fs.existsSync(executionMarker), false, 'The refused command must not start an execution session');
    assert.match(JSON.stringify(result), /trusted PowerShell parser/i);
  });
}

async function testSpawnGuardAndMissingNative(dir) {
  const fixture = path.join(dir, process.platform === 'win32' ? 'pwsh.exe' : 'pwsh');
  fs.writeFileSync(fixture, 'fixture executable, never run', { mode: 0o700 });
  const marker = path.join(dir, 'spawn-attempted');
  const original = childProcess.spawn;
  childProcess.spawn = () => {
    fs.writeFileSync(marker, 'unexpected parser or fallback launch');
    throw new Error('An untrusted parser launch was attempted');
  };
  syncBuiltinESMExports();
  try {
    let failure;
    try { await readPowerShellCommands(command, fixture); } catch (error) { failure = error; }
    assert.equal(fs.existsSync(marker), false, 'Identity validation must precede every parser spawn');
    assert.match(failure?.message ?? '', /trusted PowerShell parser/i);
    await assert.rejects(async () => readPowerShellCommands(command, path.join(dir, 'missing', path.basename(fixture))), /trusted PowerShell parser/i);
    assert.match(JSON.stringify(await refusedStart(fixture)), /trusted PowerShell parser/i);
    assert.equal(fs.existsSync(marker), false, 'start_process must refuse through the reader failure channel');

    await withEnv({ PATH: dir }, async () => {
      assert.match(JSON.stringify(await refusedStart(process.platform === 'win32' ? 'pwsh.exe' : 'pwsh')), /trusted PowerShell parser/i);
      assert.equal(fs.existsSync(marker), false, 'Changing PATH after import must not approve a new parser identity');
    });
    const emptyPath = path.join(dir, 'empty-path');
    fs.mkdirSync(emptyPath);
    await withEnv({ PATH: emptyPath }, async () => {
      const isolated = await import('../dist/utils/powershell-commands.js?missing-native-parser');
      await assert.rejects(async () => isolated.readPowerShellCommands(command, fixture), /trusted PowerShell parser/i);
      assert.equal(fs.existsSync(marker), false, 'No trusted endpoint must never trigger a candidate or alternate parser probe');
    });
  } finally {
    childProcess.spawn = original;
    syncBuiltinESMExports();
  }
}

async function testNativeIdentitiesAndCache(dir) {
  const names = process.platform === 'win32' ? ['powershell', 'pwsh'] : ['pwsh'];
  const installed = names.map((name) => ({ name, program: resolveShellPath(name) })).filter(({ program }) => program !== null);
  if (!installed.length) {
    skip('No native PowerShell on launch PATH for actual parser identity/profile/cache checks');
    return;
  }
  const seen = new Set();
  for (const { name, program } of installed) {
    const byName = await readPowerShellCommands(command, name);
    assert.ok(byName.commands.some((found) => found.name.toLowerCase() === 'write-output'), `${name}: actual native AST reading`);
    const pids = runningPowerShellHelpers();
    assert.equal(pids.length, seen.size + 1, 'Each native family has its own helper');
    const currentPid = pids.find((pid) => !seen.has(pid));
    seen.add(currentPid);
    assert.deepEqual(await readPowerShellCommands(command, program), byName, 'Absolute native identity keeps its grammar');
    const aliasDir = path.join(dir, `alias-${name}`);
    let alias;
    if (process.platform === 'win32') {
      fs.symlinkSync(path.dirname(program), aliasDir, 'junction');
      alias = path.join(aliasDir, path.basename(program));
    } else {
      fs.mkdirSync(aliasDir);
      alias = path.join(aliasDir, name);
      fs.symlinkSync(program, alias);
    }
    assert.deepEqual(await readPowerShellCommands(command, alias), byName, 'A matching filesystem alias uses the native parser');
    assert.deepEqual(new Set(runningPowerShellHelpers()), seen, 'Matching aliases reuse the same native helper');
    console.log(`✓ ${name}: native AST, absolute path, filesystem alias and helper cache`);
  }
}

export default async function runTests() {
  if (!isTestHome()) throw new Error('Run through test/run-all-tests.js so profiles and configuration use an isolated home');
  const dir = createTempDir('dc-test-parser-trust-');
  const before = new Set(runningPowerShellHelpers());
  try {
    await testActualUntrustedStartup(dir);
    await testSpawnGuardAndMissingNative(dir);
    await testNativeIdentitiesAndCache(dir);
  } finally {
    for (const pid of runningPowerShellHelpers()) {
      if (!before.has(pid)) {
        try { process.kill(pid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('✓ Untrusted PowerShell identities refuse before parser launch; available native identities retain their readings');
  return true;
}

runIfMain(import.meta.url, runTests);
