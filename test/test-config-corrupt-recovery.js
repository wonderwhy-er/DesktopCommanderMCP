import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_FILE = fileURLToPath(import.meta.url);
const TIMEOUT_MS = 5_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function worker() {
  const { configManager } = await import('../dist/config-manager.js');
  const { CONFIG_FILE } = await import('../dist/config.js');
  const events = [];
  configManager.emitCorruptConfigTelemetry = async (telemetry) => { events.push(telemetry); };

  const firstCorrupt = readFileSync(CONFIG_FILE, 'utf8');
  const config = await configManager.getConfig();
  assert.equal(configManager.isFirstRun(), false, 'corrupt existing config is not a first run');
  assert.equal(config.welcomeOnboardingEligible, false);
  assert.equal(config.pendingWelcomeOnboarding, false);
  assert.equal(config.clientId, '11111111-1111-4111-8111-111111111111');
  assert.doesNotThrow(() => JSON.parse(readFileSync(CONFIG_FILE, 'utf8')));
  assert.equal(events.length, 1);
  assert.equal(events[0].phase, 'startup');
  assert.equal(events[0].parse_error_kind, 'truncated');
  assert.equal(events[0].config_bytes, Buffer.byteLength(firstCorrupt));
  assert.equal(events[0].temp_file_count, 1);
  assert.equal(events[0].persisted_version, '0.2.48');
  assert.equal(events[0].backup_created, true);
  assert.equal(events[0].recovered_by_other_process, false);

  const dir = path.dirname(CONFIG_FILE);
  const base = path.basename(CONFIG_FILE);
  const startupBackups = readdirSync(dir).filter((name) => name.startsWith(`${base}.corrupt.`));
  assert.equal(startupBackups.length, 1);
  assert.equal(readFileSync(path.join(dir, startupBackups[0]), 'utf8'), firstCorrupt);

  // Corruption that appears after startup must also recover on the next durable mutation.
  const secondCorrupt = '{"telemetryEnabled": false, BROKEN}';
  writeFileSync(CONFIG_FILE, secondCorrupt);
  await configManager.setValue('__afterRecovery', 42);
  const finalConfig = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  assert.equal(finalConfig.__afterRecovery, 42);
  assert.equal(finalConfig.telemetryEnabled, false, 'explicit telemetry opt-out survives recoverable malformed JSON');
  const mutationEvent = events.slice(1).find((event) => event.phase === 'mutation');
  assert.ok(mutationEvent, 'mutation should recover the corrupt config');
  assert.equal(mutationEvent.parse_error_kind, 'invalid_json');
  assert.equal(mutationEvent.backup_created, true);
  assert.equal(mutationEvent.recovered_by_other_process, false);

  // A malformed external edit must be recovered by the file watcher even if no
  // tool/config mutation happens afterward. Let watcher notifications from the
  // previous mutation settle first; one process can legitimately observe the
  // same corruption through both paths.
  await sleep(200);
  const beforeWatcherCorruption = events.length;
  writeFileSync(CONFIG_FILE, '{"telemetryEnabled": false, "watcher": {');
  const watcherDeadline = Date.now() + TIMEOUT_MS;
  let watcherEvent;
  while (!watcherEvent && Date.now() < watcherDeadline) {
    watcherEvent = events.slice(beforeWatcherCorruption).find((event) =>
      event.phase === 'watcher' && event.parse_error_kind === 'truncated'
    );
    if (!watcherEvent) await sleep(25);
  }
  assert.ok(watcherEvent, 'watcher should report and recover the externally corrupted config');
  assert.equal(watcherEvent.backup_created, true);
  assert.doesNotThrow(() => JSON.parse(readFileSync(CONFIG_FILE, 'utf8')));

  process.send?.({ type: 'done' });
}

async function parent() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dc-config-corrupt-'));
  const dir = path.join(home, '.claude-server-commander');
  const configPath = path.join(dir, 'config.json');
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, '{"telemetryEnabled": true, "clientId": "11111111-1111-4111-8111-111111111111", "version": "0.2.48", "usageStats": {');
  writeFileSync(`${configPath}.999.123.tmp`, 'leftover temp');

  const child = fork(TEST_FILE, [], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      DC_CONFIG_CORRUPT_WORKER: '1',
      DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1',
    },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for corrupt config recovery test')), TIMEOUT_MS);
      child.on('message', (message) => {
        if (message.type === 'done') { clearTimeout(timer); resolve(); }
      });
      child.on('exit', (code) => {
        if (code && code !== 0) { clearTimeout(timer); reject(new Error(`worker exited ${code}`)); }
      });
    });
    console.log('✓ corrupt config is backed up, recovered, classified, and observable at startup, mutation, and watcher time');
  } finally {
    const exited = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
    rmSync(home, { recursive: true, force: true });
  }
}

if (process.env.DC_CONFIG_CORRUPT_WORKER === '1') await worker(); else await parent();
