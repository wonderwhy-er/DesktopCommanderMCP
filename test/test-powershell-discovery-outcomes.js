import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { createTempDir } from './helpers/test-env.js';
import { runIfMain } from './helpers/run-if-main.js';

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

export default async function runTests() {
  await withCandidates({}, (discover, probes) => {
    assert.deepEqual(discover(), [], 'Only genuine absence permits an empty shell list');
    assert.deepEqual(probes, [], 'Missing executables must not be launched by bare name');
  });
  await withCandidates({ powershell: valid(5), pwsh: valid(7) }, (discover, probes) => {
    const first = discover();
    assert.deepEqual(first, ['powershell', 'pwsh'], 'Keep the existing candidate order and names');
    first.length = 0;
    assert.deepEqual(discover(), ['powershell', 'pwsh'], 'Callers cannot modify the cached list');
    assert.equal(probes.length, 2, 'Successful discovery is cached');
  });
  await withCandidates({ pwsh: valid(7) }, (discover) => {
    assert.deepEqual(discover(), ['pwsh'], 'A genuinely absent Windows PowerShell does not prevent pwsh');
  });

  for (const [name, result, reason] of [
    ['nonzero exit', { ...valid(7), status: 23 }, /exit.*23/i],
    ['launch error', { error: { code: 'EACCES', message: 'fixture permission denied' } }, /EACCES/],
    ['disappeared after discovery', { error: { code: 'ENOENT', message: 'fixture disappeared' } }, /ENOENT/],
    ['timeout', { error: { code: 'ETIMEDOUT', message: 'fixture timeout' }, status: null }, /timed out|timeout/i],
    ['signal', { status: null, signal: 'SIGTERM', stdout: '' }, /SIGTERM/],
    ['malformed response', { ...valid(7), stdout: 'not PowerShell' }, /version|malformed/i],
    ['empty response', { ...valid(7), stdout: '' }, /version|malformed/i],
    ['missing response', { status: 0, stdout: null }, /version|malformed/i],
  ]) {
    await withCandidates({ pwsh: result }, (discover) => {
      assert.throws(discover, (error) => {
        assert.match(error.message, /pwsh/, `${name}: identify the failed candidate`);
        assert.match(error.message, reason, `${name}: explain why it failed`);
        return true;
      }, `${name}: an installed but broken interpreter must fail, not become a skip`);
    });
  }
  for (const candidates of [
    { powershell: { ...valid(5), status: 9 }, pwsh: valid(7) },
    { powershell: valid(5), pwsh: { ...valid(7), status: 9 } },
  ]) {
    await withCandidates(candidates, (discover) => {
      const broken = candidates.powershell.status !== 0 ? 'powershell' : 'pwsh';
      assert.throws(discover, new RegExp(`${broken}.*9`), 'A healthy candidate must not hide another installed failure');
      candidates[broken] = valid(broken === 'powershell' ? 5 : 7);
      assert.deepEqual(discover(), ['powershell', 'pwsh'], 'A failed probe must not cache partial success or absence');
    });
  }
  await withCandidates({ pwsh: valid(7) }, (discover, probes) => {
    assert.deepEqual(discover(), ['pwsh']);
    assert.ok(probes.every(({ program }) => path.isAbsolute(program)), 'Probe the resolved executable');
  });
  console.log('✓ PowerShell discovery distinguishes absence, valid interpreters and broken probes');
  return true;
}

runIfMain(import.meta.url, runTests);
