import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A reader in another DC process (e.g. a config watcher reload) can hold
// config.json open for a few milliseconds. On Windows, renaming over an open
// file fails with EPERM, so a durable write must outlast that reader.
const TEST_FILE = fileURLToPath(import.meta.url);
const HOLD_MS = 150;
const TIMEOUT_MS = 5_000;

async function writer() {
  const { CONFIG_FILE } = await import('../dist/config.js');
  const { configManager } = await import('../dist/config-manager.js');
  await configManager.getConfig();
  const fd = openSync(CONFIG_FILE, 'r');
  setTimeout(() => closeSync(fd), HOLD_MS);
  try {
    await configManager.setValue('__heldTarget', 'written');
    process.send?.({ type: 'done' });
  } catch (error) {
    process.send?.({ type: 'error', message: error.stack || error.message });
  }
}

async function parent() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dc-held-target-'));
  const configPath = path.join(home, '.claude-server-commander', 'config.json');
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ telemetryEnabled: false, welcomeOnboardingEligible: false, pendingWelcomeOnboarding: false }));
  const child = fork(TEST_FILE, [], { env: { ...process.env, HOME: home, USERPROFILE: home, DC_HELD_TARGET_WORKER: '1' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  try {
    const message = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`writer did not finish within ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
      child.once('message', (m) => { clearTimeout(timer); resolve(m); });
    });
    assert.equal(message.type, 'done', `setValue failed while config.json was held open:\n${message.message}`);
    assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).__heldTarget, 'written');
    console.log(`✓ config write succeeds while another reader holds config.json open for ${HOLD_MS}ms`);
  } finally {
    const exited = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
    rmSync(home, { recursive: true, force: true });
  }
}

if (process.env.DC_HELD_TARGET_WORKER === '1') await writer(); else await parent();
