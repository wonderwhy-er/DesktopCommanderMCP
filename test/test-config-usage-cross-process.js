import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runIfMain } from './helpers/run-if-main.js';

const TEST_FILE = fileURLToPath(import.meta.url);
const WORKERS = 8;
// Each wait ends when its message or the last save arrives (8 processes
// starting at once, then 8 locked writes: about a second here); this much
// holds up on a loaded machine
const TIMEOUT_MS = 30_000;
// A save applied twice would land SAVE_RETRY_MS (250 ms) after the first
const SETTLE_MS = 500;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** usageStats in config.json, or undefined while it can't be read (a write may be replacing it) */
function readUsageStats(configPath) {
  try {
    return JSON.parse(readFileSync(configPath, 'utf8')).usageStats;
  } catch {
    return undefined;
  }
}

async function worker() {
  const { configManager } = await import('../dist/config-manager.js');
  const { usageTracker } = await import('../dist/utils/usageTracker.js');
  await configManager.getConfig();
  process.send?.({ type: 'ready' });
  process.on('message', async (message) => {
    if (message.type !== 'track') return;
    try {
      // Its save runs in the background: the parent watches config.json for it
      await usageTracker.trackSuccess('list_processes');
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
    // Read config.json until every increment has landed, however long the
    // locked writes take; an increment that was lost never lands, and the
    // count is checked at the deadline
    const deadline = Date.now() + TIMEOUT_MS;
    while ((readUsageStats(configPath)?.totalToolCalls ?? 0) < WORKERS && Date.now() < deadline) await sleep(50);
    await sleep(SETTLE_MS);
    const stats = JSON.parse(readFileSync(configPath, 'utf8')).usageStats;
    assert.equal(stats.totalToolCalls, WORKERS, 'all process increments must survive');
    assert.equal(stats.successfulCalls, WORKERS);
    assert.equal(stats.toolCounts.list_processes, WORKERS);
    assert.equal(stats.processOperations, WORKERS);
    console.log(`✓ usage counters preserve ${WORKERS} concurrent process increments`);
  } finally {
    // Removed once the children are gone: until then they watch the config
    // folder, and a slow exit on a loaded machine would make the removal fail
    const exits = children.map((child) => child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => child.once('exit', resolve)));
    children.forEach((child) => child.kill('SIGTERM'));
    await Promise.all(exits);
    rmSync(home, { recursive: true, force: true });
  }
}

if (process.env.DC_USAGE_WORKER === '1') await worker(); else await runIfMain(import.meta.url, parent);
