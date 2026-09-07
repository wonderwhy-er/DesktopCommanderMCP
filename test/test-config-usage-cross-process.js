import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_FILE = fileURLToPath(import.meta.url);
const WORKERS = 8;
const TIMEOUT_MS = 8_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function worker() {
  const { configManager } = await import('../dist/config-manager.js');
  const { usageTracker } = await import('../dist/utils/usageTracker.js');
  await configManager.getConfig();
  process.send?.({ type: 'ready' });
  process.on('message', async (message) => {
    if (message.type !== 'track') return;
    try {
      await usageTracker.trackSuccess('list_processes');
      await sleep(400);
      process.send?.({ type: 'done' });
    } catch (error) {
      process.send?.({ type: 'error', message: error.stack || error.message });
    }
  });
}

function waitFor(child, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), TIMEOUT_MS);
    const onMessage = (message) => {
      if (message.type === 'error') return finish(new Error(message.message));
      if (message.type === type) finish(null, message);
    };
    const finish = (error, value) => { clearTimeout(timer); child.off('message', onMessage); error ? reject(error) : resolve(value); };
    child.on('message', onMessage);
  });
}

async function parent() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dc-usage-race-'));
  const configPath = path.join(home, '.claude-server-commander', 'config.json');
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ telemetryEnabled: false, welcomeOnboardingEligible: false, pendingWelcomeOnboarding: false }));
  const children = Array.from({ length: WORKERS }, () => fork(TEST_FILE, [], { env: { ...process.env, HOME: home, USERPROFILE: home, DC_USAGE_WORKER: '1' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }));
  try {
    await Promise.all(children.map((child) => waitFor(child, 'ready')));
    const done = children.map((child) => waitFor(child, 'done'));
    children.forEach((child) => child.send({ type: 'track' }));
    await Promise.all(done);
    const stats = JSON.parse(readFileSync(configPath, 'utf8')).usageStats;
    assert.equal(stats.totalToolCalls, WORKERS, 'all process increments must survive');
    assert.equal(stats.successfulCalls, WORKERS);
    assert.equal(stats.toolCounts.list_processes, WORKERS);
    assert.equal(stats.processOperations, WORKERS);
    console.log(`✓ usage counters preserve ${WORKERS} concurrent process increments`);
  } finally {
    children.forEach((child) => child.kill('SIGTERM'));
    rmSync(home, { recursive: true, force: true });
  }
}

if (process.env.DC_USAGE_WORKER === '1') await worker(); else await parent();
