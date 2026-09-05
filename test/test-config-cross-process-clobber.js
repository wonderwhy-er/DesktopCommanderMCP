import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_FILE = fileURLToPath(import.meta.url);
const TIMEOUT_MS = 5_000;
const RESTRICTED_DIR = path.join(os.tmpdir(), 'dc-issue-678-restricted');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runWorker() {
  const { configManager } = await import('../dist/config-manager.js');
  const { CONFIG_FILE } = await import('../dist/config.js');
  await configManager.getConfig();
  process.send?.({ type: 'ready' });

  process.on('message', async (message) => {
    try {
      if (message.type === 'set-setting') {
        await configManager.setValue('allowedDirectories', [RESTRICTED_DIR]);
        process.send?.({ type: 'setting-written' });
      }
      if (message.type === 'write-stats') {
        await configManager.setValueNonBlocking('usageStats', { issue678Marker: 'stale-process-a' });
        const deadline = Date.now() + TIMEOUT_MS;
        while (Date.now() < deadline) {
          try {
            const disk = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
            if (disk.usageStats?.issue678Marker === 'stale-process-a') {
              process.send?.({ type: 'stats-flushed' });
              return;
            }
          } catch {
            // Another process may be between truncate and write; retry.
          }
          await sleep(10);
        }
        throw new Error('Timed out waiting for non-blocking usageStats flush');
      }

      if (message.type === 'exit') process.exit(0);
    } catch (error) {
      process.send?.({ type: 'error', message: error.message, stack: error.stack });
    }
  });
}

function waitFor(child, type) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), TIMEOUT_MS);
    const onMessage = (message) => {
      if (message.type === 'error') {
        cleanup();
        reject(new Error(message.stack || message.message));
      } else if (message.type === type) {
        cleanup();
        resolve(message);
      }
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`Child exited with code ${code} while waiting for ${type}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    child.on('message', onMessage);
    child.on('exit', onExit);
  });
}

function startWorker(home) {
  return fork(TEST_FILE, [], {
    env: { ...process.env, HOME: home, USERPROFILE: home, DC_ISSUE_678_WORKER: '1' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
}
async function runParent() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dc-issue-678-'));
  const configPath = path.join(home, '.claude-server-commander', 'config.json');
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({
    allowedDirectories: [],
    telemetryEnabled: false,
    welcomeOnboardingEligible: false,
    pendingWelcomeOnboarding: false,
  }, null, 2));

  const a = startWorker(home);
  const b = startWorker(home);
  try {
    await Promise.all([waitFor(a, 'ready'), waitFor(b, 'ready')]);

    const settingWritten = waitFor(b, 'setting-written');
    b.send({ type: 'set-setting' });
    await settingWritten;

    const afterSetting = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.deepStrictEqual(afterSetting.allowedDirectories, [RESTRICTED_DIR]);

    const statsFlushed = waitFor(a, 'stats-flushed');
    a.send({ type: 'write-stats' });
    await statsFlushed;
    const finalConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.deepStrictEqual(
      finalConfig.allowedDirectories,
      [RESTRICTED_DIR],
      'a stale process usageStats save must not overwrite another process config change'
    );
    console.log('✓ stale usageStats save preserves another process config change');
  } finally {
    for (const child of [a, b]) {
      if (child.connected) child.send({ type: 'exit' });
      child.kill('SIGTERM');
    }
    rmSync(home, { recursive: true, force: true });
  }
}

if (process.env.DC_ISSUE_678_WORKER === '1') {
  await runWorker();
} else {
  await runParent();
}
