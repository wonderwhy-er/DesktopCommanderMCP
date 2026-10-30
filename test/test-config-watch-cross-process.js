import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runIfMain } from './helpers/run-if-main.js';

const TEST_FILE = fileURLToPath(import.meta.url);
// Each wait ends when its message or the reload arrives (tens of ms here: the
// watcher reloads 20 ms after a change); this much holds up on a loaded machine
const TIMEOUT_MS = 30_000;
// A reload that writes config.json back would do so within tens of ms, and again
// and again; this long still sees it when a loaded machine slows it down
const NO_WRITE_BACK_MS = 1_000;
const KEY = '__crossProcessWatchTest';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function worker() {
  const { configManager } = await import('../dist/config-manager.js');
  await configManager.getConfig();
  process.send?.({ type: 'ready' });
  process.on('message', async (message) => {
    try {
      if (message.type === 'set') {
        await configManager.setValue(KEY, message.value);
        process.send?.({ type: 'set-done' });
      } else if (message.type === 'await-value') {
        const deadline = Date.now() + TIMEOUT_MS;
        while (Date.now() < deadline) {
          if (await configManager.getValue(KEY) === message.value) {
            process.send?.({ type: 'observed' });
            return;
          }
          await sleep(20);
        }
        throw new Error('running process never observed config change from another process');
      }
    } catch (error) {
      process.send?.({ type: 'error', message: error.stack || error.message });
    }
  });
}

function waitFor(child, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), TIMEOUT_MS + 500);
    const onMessage = (message) => {
      if (message.type === 'error') return finish(new Error(message.message));
      if (message.type === type) finish(null, message);
    };
    const finish = (error, value) => {
      clearTimeout(timer); child.off('message', onMessage);
      error ? reject(error) : resolve(value);
    };
    child.on('message', onMessage);
  });
}

function spawnWorker(home) {
  return fork(TEST_FILE, [], { env: { ...process.env, HOME: home, USERPROFILE: home, DC_WATCH_WORKER: '1' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
}

async function parent() {
  const value = `watch-${Date.now()}`;
  const home = mkdtempSync(path.join(os.tmpdir(), 'dc-watch-'));
  const configPath = path.join(home, '.claude-server-commander', 'config.json');
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ telemetryEnabled: false, welcomeOnboardingEligible: false, pendingWelcomeOnboarding: false }));
  const a = spawnWorker(home), b = spawnWorker(home);
  try {
    await Promise.all([waitFor(a, 'ready'), waitFor(b, 'ready')]);
    const observed = waitFor(a, 'observed');
    a.send({ type: 'await-value', value });
    const setDone = waitFor(b, 'set-done');
    b.send({ type: 'set', value });
    await setDone;
    await observed;
    const afterReload = statSync(configPath).mtimeMs;
    await sleep(NO_WRITE_BACK_MS);
    assert.equal(statSync(configPath).mtimeMs, afterReload, 'watch reload must not write config back or create a loop');
    console.log('✓ running process reloads config after another process changes it without a write loop');
  } finally {
    const exits = [a, b].map((child) => child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => child.once('exit', resolve)));
    a.kill('SIGTERM'); b.kill('SIGTERM');
    await Promise.all(exits);
    rmSync(home, { recursive: true, force: true });
  }
}

if (process.env.DC_WATCH_WORKER === '1') await worker(); else await runIfMain(import.meta.url, parent);
