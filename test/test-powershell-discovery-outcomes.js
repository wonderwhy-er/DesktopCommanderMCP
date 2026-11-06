import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { before, describe, test } from 'node:test';
import { createTempDir, isTestHome } from './helpers/test-env.js';

let sequence = 0;

// Real executable fixtures exercise PATH discovery; the version process is mocked.
async function withCandidates(candidates, check) {
  const dir = createTempDir('dc-test-powershell-discovery-');
  const saved = {
    path: process.env.PATH,
    platform: Object.getOwnPropertyDescriptor(process, 'platform'),
    spawnSync: childProcess.spawnSync,
    osPlatform: os.platform,
  };
  const probes = [];
  try {
    for (const name of Object.keys(candidates)) {
      const executable = path.join(dir, name + (process.platform === 'win32' ? '.EXE' : ''));
      fs.writeFileSync(executable, 'fixture, never executed');
      fs.chmodSync(executable, 0o755);
    }
    process.env.PATH = dir;
    // Exercise both Windows candidates on every host; path resolution stays native.
    Object.defineProperty(process, 'platform', { ...saved.platform, value: 'win32' });
    os.platform = () => saved.platform.value;
    childProcess.spawnSync = (program, args, options) => {
      const name = path.basename(program).replace(/\.exe$/i, '');
      assert.ok(Object.hasOwn(candidates, name), `Unexpected probe: ${program}`);
      assert.equal(args.at(-1), '$PSVersionTable.PSVersion.Major');
      assert.ok(args.includes('-NoProfile') && args.includes('-NonInteractive'));
      assert.equal(options.timeout, 30_000);
      probes.push({ program, name });
      return candidates[name];
    };
    syncBuiltinESMExports();
    const helper = await import(`./helpers/powershell.js?discovery=${++sequence}`);
    await check(helper.installedPowerShells, probes);
  } finally {
    childProcess.spawnSync = saved.spawnSync;
    os.platform = saved.osPlatform;
    syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', saved.platform);
    if (saved.path === undefined) delete process.env.PATH;
    else process.env.PATH = saved.path;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const valid = (major) => ({ status: 0, signal: null, stdout: `${major}\r\n`, stderr: '' });

describe('PowerShell discovery outcomes', { concurrency: false }, () => {
  before(() => assert.ok(isTestHome(), 'Run through test/run-all-tests.js with an isolated home'));

  test('unresolved executables produce an empty list without launching a probe', async () => {
    await withCandidates({}, (discover, probes) => {
      assert.deepEqual(discover(), [], 'Unresolved executables are omitted');
      assert.deepEqual(probes, [], 'Missing executables must not be launched by bare name');
    });
  });

  test('successful discovery preserves candidate order', async () => {
    await withCandidates({ powershell: valid(5), pwsh: valid(7) }, (discover) => {
      const shellNames = discover();
      assert.deepEqual(shellNames, ['powershell', 'pwsh'], 'Keep the existing candidate order and names');
    });
  });

  test('successful discovery returns a defensive copy', async () => {
    await withCandidates({ powershell: valid(5), pwsh: valid(7) }, (discover) => {
      const shellNames = discover();
      shellNames.length = 0;
      assert.deepEqual(discover(), ['powershell', 'pwsh'], 'Callers cannot modify the cached list');
    });
  });

  test('successful discovery caches its version probes', async () => {
    await withCandidates({ powershell: valid(5), pwsh: valid(7) }, (discover, probes) => {
      discover();
      discover();
      assert.equal(probes.length, 2, 'Successful discovery is cached');
    });
  });

  test('an unresolved Windows PowerShell does not prevent a working pwsh', async () => {
    await withCandidates({ pwsh: valid(7) }, (discover) => {
      assert.deepEqual(discover(), ['pwsh']);
    });
  });

  for (const [failureName, probeOutput, reason] of [
    ['nonzero exit', { ...valid(7), status: 23 }, /exit.*23/i],
    ['launch error', { error: { code: 'EACCES', message: 'fixture permission denied' } }, /EACCES/],
    ['an executable missing after resolution', { error: { code: 'ENOENT', message: 'fixture disappeared' } }, /ENOENT/],
    ['timeout', { error: { code: 'ETIMEDOUT', message: 'fixture timeout' }, status: null }, /timed out|timeout/i],
    ['signal', { status: null, signal: 'SIGTERM', stdout: '' }, /SIGTERM/],
    ['malformed response', { ...valid(7), stdout: 'not PowerShell' }, /version|malformed/i],
    ['empty response', { ...valid(7), stdout: '' }, /version|malformed/i],
    ['missing response', { status: 0, stdout: null }, /version|malformed/i],
  ]) {
    test(`a resolved pwsh with ${failureName} fails discovery instead of becoming a skip`, async () => {
      await withCandidates({ pwsh: probeOutput }, (discover) => {
        assert.throws(discover, (error) => {
          assert.match(error.message, /pwsh/, `${failureName}: identify the failed candidate`);
          assert.match(error.message, reason, `${failureName}: explain why it failed`);
          return true;
        }, 'A resolved but broken interpreter must fail, not become a skip');
      });
    });
  }

  for (const [failingShell, candidates, repairedMajorVersion] of [
    ['powershell', { powershell: { ...valid(5), status: 9 }, pwsh: valid(7) }, 5],
    ['pwsh', { powershell: valid(5), pwsh: { ...valid(7), status: 9 } }, 7],
  ]) {
    test(`a working peer does not hide ${failingShell} failure or poison later recovery`, async () => {
      await withCandidates(candidates, (discover) => {
        assert.throws(discover, new RegExp(`${failingShell}.*9`));
        candidates[failingShell] = valid(repairedMajorVersion);
        assert.deepEqual(discover(), ['powershell', 'pwsh'], 'Failed discovery must not cache partial success');
      });
    });
  }

  test('the version probe uses the resolved executable rather than a working-directory name', async () => {
    await withCandidates({ pwsh: valid(7) }, (discover, probes) => {
      assert.deepEqual(discover(), ['pwsh']);
      assert.ok(probes.every(({ program }) => path.isAbsolute(program)), 'Probe the resolved executable');
    });
  });
});
