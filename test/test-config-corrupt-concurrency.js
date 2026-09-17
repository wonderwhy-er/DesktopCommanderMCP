import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_FILE = fileURLToPath(import.meta.url);
const TIMEOUT_MS = 5_000;

async function worker() {
  const { configManager } = await import('../dist/config-manager.js');
  const config = await configManager.getConfig();
  assert.equal(configManager.isFirstRun(), false);
  assert.deepEqual(config.blockedCommands, ['rm', 'sudo']);
  assert.deepEqual(config.allowedDirectories, ['/safe/project']);
  process.send?.({ type: 'done' });
}

function runWorker(home) {
  return new Promise((resolve, reject) => {
    const child = fork(TEST_FILE, [], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        DC_CONFIG_CORRUPT_CONCURRENCY_WORKER: '1',
        DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1',
      },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('timeout waiting for concurrent corrupt-config worker'));
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
}

async function parent() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dc-config-corrupt-concurrency-'));
  const dir = path.join(home, '.claude-server-commander');
  const configPath = path.join(dir, 'config.json');
  mkdirSync(dir, { recursive: true });
  const corrupt = '{"blockedCommands":["rm","sudo"],"allowedDirectories":["/safe/project"],"telemetryEnabled":false,"usageStats":{';
  writeFileSync(configPath, corrupt);

  await Promise.all([runWorker(home), runWorker(home)]);
  const base = path.basename(configPath);
  const backups = readdirSync(dir).filter((name) => name.startsWith(`${base}.corrupt.`));
  assert.equal(backups.length, 1, 'only one process should preserve the shared corrupt config');
  assert.equal(readFileSync(path.join(dir, backups[0]), 'utf8'), corrupt);

  const finalConfig = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.deepEqual(finalConfig.blockedCommands, ['rm', 'sudo']);
  assert.deepEqual(finalConfig.allowedDirectories, ['/safe/project']);
  assert.equal(finalConfig.telemetryEnabled, false);
  console.log('✓ concurrent corrupt-config startup recovers once and both processes start');
}

if (process.env.DC_CONFIG_CORRUPT_CONCURRENCY_WORKER === '1') {
  await worker();
} else {
  await parent();
}
