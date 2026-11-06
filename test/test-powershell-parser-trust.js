import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { before, describe, test } from 'node:test';
import { configManager } from '../dist/config-manager.js';
import { startProcess } from '../dist/tools/improved-process-tools.js';
import { resolveShellPath } from '../dist/utils/shell.js';
import { readPowerShellCommands, runningPowerShellHelpers } from '../dist/utils/powershell-commands.js';
import { createTempDir, isTestHome, withEnv } from './helpers/test-env.js';

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

async function testActualUntrustedStartup(dir, testContext) {
  if (process.platform === 'win32') {
    testContext.skip('Actual executable marker uses a POSIX script; Windows runs spawn-guard and native-parser checks');
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
    assert.equal(fs.existsSync(parserMarker), false,
      'The caller-selected program must not start as the parser before refusal');
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
    const missingCandidate = path.join(dir, 'missing', path.basename(fixture));
    await assert.rejects(async () => readPowerShellCommands(command, missingCandidate), /trusted PowerShell parser/i);
    assert.match(JSON.stringify(await refusedStart(fixture)), /trusted PowerShell parser/i);
    assert.equal(fs.existsSync(marker), false, 'start_process must refuse through the reader failure channel');

    await withEnv({ PATH: dir }, async () => {
      const bareName = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh';
      assert.match(JSON.stringify(await refusedStart(bareName)), /trusted PowerShell parser/i);
      assert.equal(fs.existsSync(marker), false, 'Changing PATH after import must not approve a new parser identity');
    });
    const emptyPath = path.join(dir, 'empty-path');
    fs.mkdirSync(emptyPath);
    await withEnv({ PATH: emptyPath }, async () => {
      const isolated = await import('../dist/utils/powershell-commands.js?missing-native-parser');
      await assert.rejects(async () => isolated.readPowerShellCommands(command, fixture), /trusted PowerShell parser/i);
      assert.equal(fs.existsSync(marker), false,
        'No trusted endpoint must trigger a candidate or alternate parser probe');
    });
  } finally {
    childProcess.spawn = original;
    syncBuiltinESMExports();
  }
}

async function testNativeIdentitiesAndCache(dir, testContext) {
  const names = process.platform === 'win32' ? ['powershell', 'pwsh'] : ['pwsh'];
  const installed = names.map((name) => ({ name, program: resolveShellPath(name) }))
    .filter(({ program }) => program !== null);
  if (!installed.length) {
    testContext.skip('No native PowerShell on launch PATH for actual parser identity/profile/cache checks');
    return;
  }
  const seen = new Set();
  for (const { name, program } of installed) {
    const byName = await readPowerShellCommands(command, name);
    assert.ok(byName.commands.some((found) => found.name.toLowerCase() === 'write-output'),
      `${name}: actual native AST reading`);
    const pids = runningPowerShellHelpers();
    assert.equal(pids.length, seen.size + 1, 'Each native family has its own helper');
    const currentPid = pids.find((pid) => !seen.has(pid));
    seen.add(currentPid);
    assert.deepEqual(await readPowerShellCommands(command, program), byName,
      'Absolute native identity keeps its grammar');
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
    assert.deepEqual(await readPowerShellCommands(command, alias), byName,
      'A matching filesystem alias uses the native parser');
    assert.deepEqual(new Set(runningPowerShellHelpers()), seen, 'Matching aliases reuse the same native helper');
    console.log(`✓ ${name}: native AST, absolute path, filesystem alias and helper cache`);
  }
}

let launchFixtureSequence = 0;

async function withLaunchAuthority(dir, runBehavior) {
  const launchDirectory = path.join(dir, 'launch-directory');
  const otherDirectory = path.join(dir, 'other-directory');
  fs.mkdirSync(path.join(launchDirectory, 'bin'), { recursive: true });
  fs.mkdirSync(otherDirectory);
  const executable = path.join(launchDirectory, 'bin', process.platform === 'win32' ? 'pwsh.EXE' : 'pwsh');
  fs.writeFileSync(executable, 'trusted launch-PATH fixture, never executed', { mode: 0o700 });
  const originalDirectory = process.cwd();
  const originalSpawn = childProcess.spawn;
  const launches = [];
  childProcess.spawn = (program, args, options) => {
    launches.push({ program, cwd: options.cwd });
    throw new Error('launch-PATH spawn intercepted');
  };
  syncBuiltinESMExports();
  try {
    await withEnv({ PATH: 'bin' }, async () => {
      process.chdir(launchDirectory);
      const reader = await import(`../dist/utils/powershell-commands.js?launch-fixture=${++launchFixtureSequence}`);
      process.chdir(otherDirectory);
      await runBehavior({ reader, executable, otherDirectory, launches });
    });
  } finally {
    process.chdir(originalDirectory);
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  }
}

async function expectApprovedParser({ reader, requested, executable, launches }) {
  const before = launches.length;
  await assert.rejects(async () => reader.readPowerShellCommands(command, requested), /spawn intercepted/);
  assert.equal(launches.length, before + 1);
  const launch = launches.at(-1);
  assert.ok(path.isAbsolute(launch.program), 'Launch-PATH approval must retain an absolute executable');
  assert.equal(fs.realpathSync(path.resolve(launch.cwd, launch.program)), fs.realpathSync(executable));
}

async function testRelativeLaunchPath(dir) {
  await withLaunchAuthority(dir, async (fixture) => {
    const { reader, executable, otherDirectory, launches } = fixture;
    await expectApprovedParser({ ...fixture, requested: executable });
    const bareName = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh';
    await expectApprovedParser({ ...fixture, requested: bareName });
    const impostor = path.join(otherDirectory, 'bin', path.basename(executable));
    fs.mkdirSync(path.dirname(impostor));
    fs.writeFileSync(impostor, 'different current-cwd executable, never run', { mode: 0o700 });
    const before = launches.length;
    await assert.rejects(async () => reader.readPowerShellCommands(command, bareName), /trusted PowerShell parser/i);
    await assert.rejects(async () => reader.readPowerShellCommands(command, impostor), /trusted PowerShell parser/i);
    assert.equal(launches.length, before, 'A resolved impostor must not use the native-name fallback');
  });
}

async function testFilesystemIdentityBounds(dir) {
  await withLaunchAuthority(dir, async (fixture) => {
    const { reader, executable, launches } = fixture;
    const aliasDirectory = path.join(dir, 'filesystem-alias');
    const alias = path.join(aliasDirectory, path.basename(executable));
    if (process.platform === 'win32') fs.symlinkSync(path.dirname(executable), aliasDirectory, 'junction');
    else {
      fs.mkdirSync(aliasDirectory);
      fs.symlinkSync(executable, alias);
    }
    await expectApprovedParser({ ...fixture, requested: alias });
    const linkDirectory = path.join(dir, 'hard-link');
    fs.mkdirSync(linkDirectory);
    const hardLink = path.join(linkDirectory, path.basename(executable));
    fs.linkSync(executable, hardLink);
    assert.notEqual(fs.realpathSync(hardLink), fs.realpathSync(executable), 'Hard links retain different real paths');
    const before = launches.length;
    await assert.rejects(async () => reader.readPowerShellCommands(command, hardLink), /trusted PowerShell parser/i);
    assert.equal(launches.length, before, 'Canonical-path policy must not silently approve a hard-link alias');
  });
}

async function withParserFixture(runBehavior) {
  const dir = createTempDir('dc-test-parser-trust-');
  const before = new Set(runningPowerShellHelpers());
  try {
    await runBehavior(dir);
  } finally {
    for (const pid of runningPowerShellHelpers()) {
      if (!before.has(pid)) {
        try { process.kill(pid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('PowerShell parser trust', { concurrency: false }, () => {
  before(() => assert.ok(isTestHome(), 'Use test/run-all-tests.js for an isolated home'));

  test('a custom executable never starts before start_process refuses it', async (testContext) => {
    await withParserFixture((dir) => testActualUntrustedStartup(dir, testContext));
  });

  test('identity mismatches and unavailable parser endpoints never trigger a probe', async () => {
    await withParserFixture(testSpawnGuardAndMissingNative);
  });

  test('relative launch PATH survives cwd changes without approving a current-cwd impostor', async () => {
    await withParserFixture(testRelativeLaunchPath);
  });

  test('filesystem symlinks or junctions match canonical paths while hard-link names remain distinct', async () => {
    await withParserFixture(testFilesystemIdentityBounds);
  });

  test('native identities and aliases preserve readings and helper caches', async (testContext) => {
    await withParserFixture((dir) => testNativeIdentitiesAndCache(dir, testContext));
  });

  test('an unreadable launch endpoint never approves a parser identity', async (testContext) => {
    await withParserFixture(async (dir) => {
      const executable = path.join(dir, process.platform === 'win32' ? 'pwsh.EXE' : 'pwsh');
      fs.writeFileSync(executable, 'unreadable identity fixture, never executed', { mode: 0o700 });
      const originalRealpath = fs.realpathSync;
      testContext.mock.method(fs, 'realpathSync', (program, ...options) => {
        if (path.resolve(String(program)) === executable) {
          throw Object.assign(new Error('controlled identity access failure'), { code: 'EACCES' });
        }
        return originalRealpath(program, ...options);
      });
      let spawned = false;
      testContext.mock.method(childProcess, 'spawn', () => {
        spawned = true;
        throw new Error('unreadable identity must not be launched');
      });
      syncBuiltinESMExports();
      try {
        await withEnv({ PATH: dir }, async () => {
          const reader = await import('../dist/utils/powershell-commands.js?unreadable-launch-endpoint');
          await assert.rejects(
            async () => reader.readPowerShellCommands(command, executable), /trusted PowerShell parser/i
          );
          assert.equal(spawned, false);
        });
      } finally {
        testContext.mock.restoreAll();
        syncBuiltinESMExports();
      }
    });
  });
});
