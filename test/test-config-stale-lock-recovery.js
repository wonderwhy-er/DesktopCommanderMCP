import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runIfMain } from './helpers/run-if-main.js';

const TEST_FILE = fileURLToPath(import.meta.url);

async function worker() {
  const { configManager } = await import('../dist/config-manager.js');
  await configManager.setValue('__staleLockRecovered', true);
  process.send?.({ type: 'done' });
}

async function parent() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dc-stale-lock-'));
  const dir = path.join(home, '.claude-server-commander');
  const configPath = path.join(dir, 'config.json');
  const lockPath = `${configPath}.lock`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, JSON.stringify({ telemetryEnabled: false, welcomeOnboardingEligible: false, pendingWelcomeOnboarding: false }));
  mkdirSync(lockPath);
  const staleTime = new Date(Date.now() - 60_000);
  utimesSync(lockPath, staleTime, staleTime);
  const child = fork(TEST_FILE, [], { env: { ...process.env, HOME: home, USERPROFILE: home, DC_STALE_LOCK_WORKER: '1' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  try {
    await new Promise((resolve, reject) => {
      // The child's start and write take well under a second here; this wait
      // ends when it is done, so 30 s holds up on a loaded machine. A stale
      // lock that isn't reclaimed fails sooner: the lock's retries give up
      // after about 9 s and the child exits with an error
      const timer = setTimeout(() => reject(new Error('stale lock blocked config write')), 30_000);
      child.on('message', (m) => { if (m.type === 'done') { clearTimeout(timer); resolve(); } });
      child.on('exit', (code) => { if (code) reject(new Error(`child exited ${code}`)); });
    });
    assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).__staleLockRecovered, true);
    assert.equal(existsSync(lockPath), false, 'stale lock should be removed after recovery');
    console.log('✓ dead-process config lock is reclaimed automatically');
  } finally {
    // Removed once the child is gone: until then it watches the config folder,
    // and a slow exit on a loaded machine would make the removal fail
    const exited = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
    rmSync(home, { recursive: true, force: true });
  }
}

if (process.env.DC_STALE_LOCK_WORKER === '1') await worker(); else await runIfMain(import.meta.url, parent);
