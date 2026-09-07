import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_FILE = fileURLToPath(import.meta.url);
const WORKERS = 8;
const TIMEOUT_MS = 8_000;

async function worker() {
  const { configManager } = await import('../dist/config-manager.js');
  await configManager.getConfig();
  process.send?.({ type: 'ready' });
  process.on('message', async (message) => {
    if (message.type !== 'create') return;
    try {
      process.send?.({ type: 'result', clientId: await configManager.getOrCreateClientId() });
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
  const home = mkdtempSync(path.join(os.tmpdir(), 'dc-client-id-race-'));
  const configPath = path.join(home, '.claude-server-commander', 'config.json');
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ telemetryEnabled: false, welcomeOnboardingEligible: false, pendingWelcomeOnboarding: false }));
  const children = Array.from({ length: WORKERS }, () => fork(TEST_FILE, [], { env: { ...process.env, HOME: home, USERPROFILE: home, DC_CLIENT_ID_WORKER: '1' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }));
  try {
    await Promise.all(children.map((child) => waitFor(child, 'ready')));
    const results = children.map((child) => waitFor(child, 'result'));
    children.forEach((child) => child.send({ type: 'create' }));
    const ids = (await Promise.all(results)).map((result) => result.clientId);
    assert.equal(new Set(ids).size, 1, `all processes must receive the same clientId, got ${ids.join(', ')}`);
    assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).clientId, ids[0]);
    console.log(`✓ ${WORKERS} simultaneous processes converge on one persistent clientId`);
  } finally {
    const exits = children.map((child) => child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => child.once('exit', resolve)));
    children.forEach((child) => child.kill('SIGTERM'));
    await Promise.all(exits);
    rmSync(home, { recursive: true, force: true });
  }
}

if (process.env.DC_CLIENT_ID_WORKER === '1') await worker(); else await parent();
