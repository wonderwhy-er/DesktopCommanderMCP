import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_FILE = fileURLToPath(import.meta.url);
const TIMEOUT_MS = 5_000;

async function worker() {
  const { configManager } = await import('../dist/config-manager.js');
  const { commandManager } = await import('../dist/command-manager.js');
  const { CONFIG_FILE } = await import('../dist/config.js');

  const config = await configManager.getConfig();
  assert.deepEqual(config.blockedCommands, ['*']);
  assert.deepEqual(config.allowedDirectories, [path.dirname(CONFIG_FILE)]);
  assert.equal(await commandManager.validateCommand('echo hello'), false);
  process.send?.({ type: 'done' });
}

async function parent() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dc-config-corrupt-fail-closed-'));
  const dir = path.join(home, '.claude-server-commander');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'config.json'), '{"defaultShell":');

  const child = fork(TEST_FILE, [], {    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      DC_CONFIG_CORRUPT_FAIL_CLOSED_WORKER: '1',
      DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1',
    },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('timeout waiting for fail-closed recovery worker'));
    }, TIMEOUT_MS);
    child.on('message', (message) => {
      if (message.type !== 'done') return;
      clearTimeout(timer);
      const exited = new Promise((done) => child.once('exit', done));
      child.kill('SIGTERM');
      exited.then(resolve);
    });
    child.on('exit', (code) => {
      if (code && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`worker exited ${code}`));
      }
    });
  });
  console.log('✓ early corrupt config recovers with fail-closed security defaults');
}

if (process.env.DC_CONFIG_CORRUPT_FAIL_CLOSED_WORKER === '1') {
  await worker();
} else {
  await parent();
}
