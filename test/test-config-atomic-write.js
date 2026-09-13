import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_FILE = fileURLToPath(import.meta.url);
const PAYLOAD = 'x'.repeat(1024 * 1024);
const WRITES = 20;
const TIMEOUT_MS = 10_000;

async function writer() {
  const { configManager } = await import('../dist/config-manager.js');
  await configManager.getConfig();
  for (let i = 0; i < WRITES; i++) await configManager.setValue('__atomicPayload', `${i}:${PAYLOAD}`);
  process.send?.({ type: 'done' });
}

async function parent() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dc-atomic-'));
  const configPath = path.join(home, '.claude-server-commander', 'config.json');
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ telemetryEnabled: false, welcomeOnboardingEligible: false, pendingWelcomeOnboarding: false }));
  const child = fork(TEST_FILE, [], { env: { ...process.env, HOME: home, USERPROFILE: home, DC_ATOMIC_WORKER: '1' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  let done = false, parseFailures = 0, reads = 0;
  child.on('message', (m) => { if (m.type === 'done') done = true; });
  const deadline = Date.now() + TIMEOUT_MS;
  try {
    while (!done && Date.now() < deadline) {
      try { JSON.parse(readFileSync(configPath, 'utf8')); } catch { parseFailures++; }
      reads++;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(done, true, 'writer should finish');
    assert.equal(parseFailures, 0, `reader observed ${parseFailures} malformed config snapshots across ${reads} reads`);
    console.log(`✓ ${reads} concurrent config reads saw only complete JSON during ${WRITES} large writes`);
  } finally {
    child.kill('SIGTERM');
    rmSync(home, { recursive: true, force: true });
  }
}

if (process.env.DC_ATOMIC_WORKER === '1') await writer(); else await parent();
