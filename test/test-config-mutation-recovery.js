import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_FILE = fileURLToPath(import.meta.url);
const TIMEOUT_MS = 5_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function worker() {
  const { configManager } = await import('../dist/config-manager.js');
  const { CONFIG_FILE } = await import('../dist/config.js');
  const { VERSION } = await import('../dist/version.js');
  await configManager.getConfig();

  // Version is runtime metadata and must survive durable mutations.
  assert.equal((await configManager.getConfig()).version, VERSION);
  await configManager.setValue('__versionTest', 1);
  assert.equal((await configManager.getConfig()).version, VERSION);

  // Simulate one pre-commit failure. Background mutations must be requeued.
  const originalMutation = configManager.performConfigMutation.bind(configManager);
  let failOnce = true;
  configManager.performConfigMutation = async (...args) => {
    if (failOnce) {
      failOnce = false;
      throw new Error('synthetic pre-commit failure');
    }
    return originalMutation(...args);
  };
  await configManager.updateValueNonBlocking('__retryCounter', (value) => (value || 0) + 1);
  const retryDeadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < retryDeadline) {
    const disk = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    if (disk.__retryCounter === 1) break;
    await sleep(25);
  }
  assert.equal(JSON.parse(readFileSync(CONFIG_FILE, 'utf8')).__retryCounter, 1);

  // A release failure after atomic rename is post-commit: do not replay it.
  configManager.performConfigMutation = originalMutation;
  const originalAcquire = configManager.acquireConfigLock.bind(configManager);
  configManager.acquireConfigLock = async () => async () => { throw new Error('synthetic release failure'); };
  await configManager.updateValueNonBlocking('__postCommitCounter', (value) => (value || 0) + 1);
  const commitDeadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < commitDeadline) {
    const disk = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    if (disk.__postCommitCounter === 1) break;
    await sleep(25);
  }
  await sleep(600);
  assert.equal(JSON.parse(readFileSync(CONFIG_FILE, 'utf8')).__postCommitCounter, 1);
  configManager.acquireConfigLock = originalAcquire;
  assert.equal((await configManager.getConfig()).version, VERSION);
  process.send?.({ type: 'done' });
}

async function parent() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dc-config-recovery-'));
  const configPath = path.join(home, '.claude-server-commander', 'config.json');
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ telemetryEnabled: false, welcomeOnboardingEligible: false, pendingWelcomeOnboarding: false }));
  const child = fork(TEST_FILE, [], { env: { ...process.env, HOME: home, USERPROFILE: home, DC_CONFIG_RECOVERY_WORKER: '1' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for recovery test')), TIMEOUT_MS + 2_000);
      child.on('message', (message) => {
        if (message.type === 'done') { clearTimeout(timer); resolve(); }
      });
      child.on('exit', (code) => {
        if (code && code !== 0) { clearTimeout(timer); reject(new Error(`worker exited ${code}`)); }
      });
    });
    console.log('✓ config mutation recovery preserves version, retries pre-commit failures, and avoids post-commit replay');
  } finally {
    const exited = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
    rmSync(home, { recursive: true, force: true });
  }
}

if (process.env.DC_CONFIG_RECOVERY_WORKER === '1') await worker(); else await parent();
