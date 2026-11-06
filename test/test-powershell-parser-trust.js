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
let launchFixtureSequence = 0;

async function refusedStart(shell) {
  const originalConfig = configManager.getConfig;
  configManager.getConfig = async () => ({ blockedCommands: [blockedToken], defaultShell: shell });
  try {
    const refusal = await startProcess({ command: blockedToken, shell, timeout_ms: 1000 });
    assert.equal(refusal.isError, true);
    assert.equal(refusal.structuredContent?.blocked, true);
    assert.ok(!JSON.stringify(refusal).includes('Process started with PID'));
    return refusal;
  } finally {
    configManager.getConfig = originalConfig;
  }
}

async function withParserFixture(runBehavior) {
  const dir = createTempDir('dc-test-parser-trust-');
  const existingPids = new Set(runningPowerShellHelpers());
  try {
    await runBehavior(dir);
  } finally {
    const cleanupFailures = runningPowerShellHelpers()
      .filter((pid) => !existingPids.has(pid))
      .flatMap((pid) => {
        try {
          process.kill(pid);
          return [];
        } catch (error) {
          // An owned helper may have exited already; other cleanup errors must surface.
          return error.code === 'ESRCH' ? [] : [error];
        }
      });
    fs.rmSync(dir, { recursive: true, force: true });
    if (cleanupFailures.length > 0) throw cleanupFailures[0];
  }
}

async function withSpawnGuard(runBehavior) {
  await withParserFixture(async (dir) => {
    const fixture = path.join(dir, process.platform === 'win32' ? 'pwsh.exe' : 'pwsh');
    fs.writeFileSync(fixture, 'fixture executable, never run', { mode: 0o700 });
    const marker = path.join(dir, 'spawn-attempted');
    const originalSpawn = childProcess.spawn;
    childProcess.spawn = () => {
      fs.writeFileSync(marker, 'unexpected parser or fallback launch');
      throw new Error('An untrusted parser launch was attempted');
    };
    syncBuiltinESMExports();
    try {
      await runBehavior({ dir, fixture, marker });
    } finally {
      childProcess.spawn = originalSpawn;
      syncBuiltinESMExports();
    }
  });
}

async function withLaunchAuthority(runBehavior) {
  await withParserFixture(async (dir) => {
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
        await runBehavior({ dir, reader, executable, otherDirectory, launches });
      });
    } finally {
      process.chdir(originalDirectory);
      childProcess.spawn = originalSpawn;
      syncBuiltinESMExports();
    }
  });
}

async function expectApprovedParser({ reader, requested, executable, launches }) {
  const previousLaunches = launches.length;
  await assert.rejects(async () => reader.readPowerShellCommands(command, requested), /spawn intercepted/);
  assert.equal(launches.length, previousLaunches + 1);
  const launch = launches.at(-1);
  assert.ok(path.isAbsolute(launch.program), 'Launch-PATH approval must retain an absolute executable');
  assert.equal(fs.realpathSync(path.resolve(launch.cwd, launch.program)), fs.realpathSync(executable));
}

function createAlias({ directory, program }) {
  const alias = path.join(directory, path.basename(program));
  if (process.platform === 'win32') {
    fs.symlinkSync(path.dirname(program), directory, 'junction');
    return alias;
  }
  fs.mkdirSync(directory);
  fs.symlinkSync(program, alias);
  return alias;
}

describe('PowerShell parser trust', { concurrency: false }, () => {
  before(() => assert.ok(isTestHome(), 'Use test/run-all-tests.js for an isolated home'));

  test('a custom executable never starts before start_process refuses it', async (testContext) => {
    if (process.platform === 'win32') {
      testContext.skip('Actual marker uses a POSIX script; Windows runs spawn-guard and native-parser checks');
      return;
    }
    await withParserFixture(async (dir) => {
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
        const refusal = await refusedStart(executable);
        assert.equal(fs.existsSync(parserMarker), false,
          'The selected program must not start as parser before refusal');
        assert.equal(fs.existsSync(executionMarker), false, 'The refused command must not start an execution session');
        assert.match(JSON.stringify(refusal), /trusted PowerShell parser/i);
      });
    });
  });

  test('mismatched and missing direct-reader identities refuse before any parser spawn', async () => {
    await withSpawnGuard(async ({ dir, fixture, marker }) => {
      await assert.rejects(async () => readPowerShellCommands(command, fixture), /trusted PowerShell parser/i);
      const missingCandidate = path.join(dir, 'missing', path.basename(fixture));
      await assert.rejects(async () => readPowerShellCommands(command, missingCandidate), /trusted PowerShell parser/i);
      assert.equal(fs.existsSync(marker), false, 'Identity validation must precede every parser spawn');
    });
  });

  test('start_process refuses a custom identity before and after a PATH change', async () => {
    await withSpawnGuard(async ({ dir, fixture, marker }) => {
      assert.match(JSON.stringify(await refusedStart(fixture)), /trusted PowerShell parser/i);
      assert.equal(fs.existsSync(marker), false, 'The reader failure must refuse start_process');
      await withEnv({ PATH: dir }, async () => {
        const bareName = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh';
        assert.match(JSON.stringify(await refusedStart(bareName)), /trusted PowerShell parser/i);
        assert.equal(fs.existsSync(marker), false, 'A PATH change must not approve a different parser identity');
      });
    });
  });

  test('missing launch endpoints do not fall back to a request-selected executable', async () => {
    await withSpawnGuard(async ({ dir, fixture, marker }) => {
      const emptyPath = path.join(dir, 'empty-path');
      fs.mkdirSync(emptyPath);
      await withEnv({ PATH: emptyPath }, async () => {
        const reader = await import('../dist/utils/powershell-commands.js?missing-native-parser');
        await assert.rejects(async () => reader.readPowerShellCommands(command, fixture), /trusted PowerShell parser/i);
        assert.equal(fs.existsSync(marker), false, 'An unavailable native endpoint must not trigger another probe');
      });
    });
  });

  test('relative launch PATH retains approved absolute and bare names after chdir', async () => {
    await withLaunchAuthority(async (fixture) => {
      await expectApprovedParser({ ...fixture, requested: fixture.executable });
      const bareName = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh';
      await expectApprovedParser({ ...fixture, requested: bareName });
    });
  });

  test('a current-cwd impostor cannot use the approved native-name fallback', async () => {
    await withLaunchAuthority(async ({ reader, executable, otherDirectory, launches }) => {
      const impostor = path.join(otherDirectory, 'bin', path.basename(executable));
      fs.mkdirSync(path.dirname(impostor));
      fs.writeFileSync(impostor, 'different current-cwd executable, never run', { mode: 0o700 });
      const bareName = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh';
      await assert.rejects(async () => reader.readPowerShellCommands(command, bareName), /trusted PowerShell parser/i);
      await assert.rejects(async () => reader.readPowerShellCommands(command, impostor), /trusted PowerShell parser/i);
      assert.equal(launches.length, 0, 'A resolved impostor must not use the native-name fallback');
    });
  });

  test('filesystem symlinks or junctions retain the approved canonical identity', async () => {
    await withLaunchAuthority(async (fixture) => {
      const alias = createAlias({ directory: path.join(fixture.dir, 'filesystem-alias'), program: fixture.executable });
      await expectApprovedParser({ ...fixture, requested: alias });
    });
  });

  test('a distinct hard-link name does not silently gain canonical-path approval', async () => {
    await withLaunchAuthority(async (fixture) => {
      const { dir, reader, executable, launches } = fixture;
      const approvedAlias = createAlias({ directory: path.join(dir, 'approved-alias'), program: executable });
      await expectApprovedParser({ ...fixture, requested: approvedAlias });
      const linkDirectory = path.join(dir, 'hard-link');
      fs.mkdirSync(linkDirectory);
      const hardLink = path.join(linkDirectory, path.basename(executable));
      fs.linkSync(executable, hardLink);
      assert.notEqual(fs.realpathSync(hardLink), fs.realpathSync(executable), 'Hard links retain different real paths');
      const previousLaunches = launches.length;
      await assert.rejects(async () => reader.readPowerShellCommands(command, hardLink), /trusted PowerShell parser/i);
      assert.equal(launches.length, previousLaunches, 'A cached native helper must not approve a hard-link alias');
    });
  });

  test('native identities and aliases preserve readings and helper caches', async (testContext) => {
    await withParserFixture(async (dir) => {
      const names = process.platform === 'win32' ? ['powershell', 'pwsh'] : ['pwsh'];
      const installed = names.map((name) => ({ name, program: resolveShellPath(name) }))
        .filter(({ program }) => program !== null);
      if (!installed.length) {
        testContext.skip('No native PowerShell on launch PATH for actual parser/cache checks');
        return;
      }
      const seen = new Set();
      for (const { name, program } of installed) {
        const byName = await readPowerShellCommands(command, name);
        assert.ok(byName.commands.some((found) => found.name.toLowerCase() === 'write-output'),
          `${name}: actual native AST reading`);
        const pids = runningPowerShellHelpers();
        assert.equal(pids.length, seen.size + 1, 'Each native family has its own helper');
        seen.add(pids.find((pid) => !seen.has(pid)));
        assert.deepEqual(await readPowerShellCommands(command, program), byName,
          'Absolute native identity keeps its grammar');
        const alias = createAlias({ directory: path.join(dir, `alias-${name}`), program });
        assert.deepEqual(await readPowerShellCommands(command, alias), byName,
          'A matching filesystem alias uses the native parser');
        assert.deepEqual(new Set(runningPowerShellHelpers()), seen, 'Matching aliases reuse the native helper');
      }
    });
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
