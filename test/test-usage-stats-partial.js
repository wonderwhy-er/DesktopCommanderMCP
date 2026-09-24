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
  const { usageTracker } = await import('../dist/utils/usageTracker.js');
  const { CONFIG_FILE } = await import('../dist/config.js');
  await usageTracker.trackSuccess('read_file');
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const stats = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')).usageStats;
    if (stats?.totalToolCalls === 1) {
      assert.equal(stats.successfulCalls, 1);
      assert.equal(stats.failedCalls, 0);
      assert.equal(stats.filesystemOperations, 1);
      assert.equal(stats.toolCounts.read_file, 1);
      assert.ok(Number.isFinite(stats.totalSessions));
      process.send?.({ type: 'done' });
      return;
    }
    await sleep(25);
  }
  throw new Error('partial usageStats update did not persist');
}

async function parent() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dc-partial-stats-'));
  const configPath = path.join(home, '.claude-server-commander', 'config.json');
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ telemetryEnabled: false, welcomeOnboardingEligible: false, pendingWelcomeOnboarding: false, usageStats: { toolCounts: {} } }));
  const child = fork(TEST_FILE, [], { env: { ...process.env, HOME: home, USERPROFILE: home, DC_PARTIAL_STATS_WORKER: '1' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for partial stats test')), TIMEOUT_MS + 1_000);
      child.on('message', (message) => { if (message.type === 'done') { clearTimeout(timer); resolve(); } });
      child.on('exit', (code) => { if (code && code !== 0) { clearTimeout(timer); reject(new Error(`worker exited ${code}`)); } });
    });
    console.log('✓ partial usageStats receive numeric defaults before counters increment');
  } finally {
    const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
    rmSync(home, { recursive: true, force: true });
  }
}

if (process.env.DC_PARTIAL_STATS_WORKER === '1') await worker(); else await parent();
