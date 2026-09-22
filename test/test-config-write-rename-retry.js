import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_FILE = fileURLToPath(import.meta.url);
// The worker's first import of the server module measured 25s over /mnt/c.
const TIMEOUT_MS = 60_000;

async function worker() {
  const { configManager } = await import('../dist/config-manager.js');
  const { CONFIG_FILE } = await import('../dist/config.js');
  const fsp = (await import('node:fs/promises')).default;

  await configManager.getConfig();

  // Windows refuses to rename over a config another process still holds, which
  // is what the two cross-process tests hit. Two refusals, then the real thing.
  const original = fsp.rename;
  let refusals = 2;
  fsp.rename = async (from, to) => {
    if (refusals-- > 0) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    return original(from, to);
  };

  try {
    await configManager.setValue('__renameUnderContention', 'kept');
  } finally {
    fsp.rename = original;
  }

  assert.equal(JSON.parse(readFileSync(CONFIG_FILE, 'utf8')).__renameUnderContention, 'kept',
    'a write whose commit was refused twice still lands');
  process.send?.({ type: 'done' });
}

async function parent() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dc-rename-retry-'));
  const dir = path.join(home, '.claude-server-commander');
  mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ telemetryEnabled: false, welcomeOnboardingEligible: false, pendingWelcomeOnboarding: false }));

  let child;
  try {
    child = fork(TEST_FILE, [], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        DC_RENAME_RETRY_WORKER: '1',
        DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1'
      },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc']
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('timeout waiting for the rename-retry worker'));
      }, TIMEOUT_MS);
      child.on('message', (message) => {
        if (message.type !== 'done') return;
        clearTimeout(timer);
        resolve();
      });
      child.on('exit', (code) => {
        if (code && code !== 0) {
          clearTimeout(timer);
          reject(new Error(`rename-retry worker exited ${code}`));
        }
      });
    });

    const leftovers = readFileSync(configPath, 'utf8');
    assert.doesNotThrow(() => JSON.parse(leftovers), 'the config is whole after the retried commit');
    console.log('✓ a config commit refused by a holder is retried, not lost');
  } finally {
    if (child) {
      const exited = child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : new Promise((done) => child.once('exit', done));
      child.kill('SIGTERM');
      await exited;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

if (process.env.DC_RENAME_RETRY_WORKER === '1') await worker(); else await parent();
