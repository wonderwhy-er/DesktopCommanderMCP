import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A reader in another process can hold config.json open while DC writes it.
// On Windows, renaming over a file whose open handle denies delete sharing
// fails (EPERM from libuv, EBUSY under POSIX rename semantics), so a durable
// write must outlast that reader.
const TEST_FILE = fileURLToPath(import.meta.url);
const HOLD_MS = 500;
const TIMEOUT_MS = 10_000;

// Node cannot choose a share mode, so on Windows a separate PowerShell process
// opens config.json allowing reads (setValue reads before it renames) but not
// delete, reports once the handle is open, and closes it after HOLD_MS.
const HOLDER_SCRIPT = [
  "$f = [IO.File]::Open($env:DC_HOLD_PATH, 'Open', 'Read', 'Read')",
  "[Console]::Out.WriteLine('HELD')",
  '[Console]::Out.Flush()',
  `Start-Sleep -Milliseconds ${HOLD_MS}`,
  '$f.Close()',
].join('; ');

async function writer() {
  const { configManager } = await import('../dist/config-manager.js');
  await configManager.getConfig();
  process.on('message', async (message) => {
    if (message.type !== 'write') return;
    try {
      await configManager.setValue('__heldTarget', 'written');
      process.send?.({ type: 'done' });
    } catch (error) {
      process.send?.({ type: 'error', message: error.stack || error.message });
    }
  });
  process.send?.({ type: 'ready' });
}

function waitForMessage(child, types) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${types.join('/')}`)), TIMEOUT_MS);
    const onMessage = (message) => {
      if (!types.includes(message.type)) return;
      clearTimeout(timer);
      child.off('message', onMessage);
      resolve(message);
    };
    child.on('message', onMessage);
  });
}

function holdOnWindows(configPath) {
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', HOLDER_SCRIPT], {
    env: { ...process.env, DC_HOLD_PATH: configPath },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = new Promise((resolve) => holder.once('exit', resolve));
  const held = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('holder did not open config.json')), TIMEOUT_MS);
    let output = '';
    holder.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('HELD')) { clearTimeout(timer); resolve(); }
    });
    holder.once('exit', (code) => { clearTimeout(timer); reject(new Error(`holder exited with ${code} before opening config.json`)); });
  });
  return { held, release: async () => { holder.kill(); await exited; } };
}

function holdOnPosix(configPath) {
  let fd = openSync(configPath, 'r');
  const close = () => { if (fd !== null) { closeSync(fd); fd = null; } };
  const timer = setTimeout(close, HOLD_MS);
  return { held: Promise.resolve(), release: async () => { clearTimeout(timer); close(); } };
}

async function parent() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dc-held-target-'));
  const configPath = path.join(home, '.claude-server-commander', 'config.json');
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ telemetryEnabled: false, welcomeOnboardingEligible: false, pendingWelcomeOnboarding: false }));
  const child = fork(TEST_FILE, [], { env: { ...process.env, HOME: home, USERPROFILE: home, DC_HELD_TARGET_WORKER: '1' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  let holder = null;
  try {
    await waitForMessage(child, ['ready']);
    holder = process.platform === 'win32' ? holdOnWindows(configPath) : holdOnPosix(configPath);
    await holder.held;
    const result = waitForMessage(child, ['done', 'error']);
    child.send({ type: 'write' });
    const message = await result;
    assert.equal(message.type, 'done', `setValue failed while config.json was held open:\n${message.message}`);
    assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).__heldTarget, 'written');
    console.log(`✓ config write succeeds while another reader holds config.json open for ${HOLD_MS}ms`);
  } finally {
    if (holder) await holder.release();
    const exited = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
    rmSync(home, { recursive: true, force: true });
  }
}

if (process.env.DC_HELD_TARGET_WORKER === '1') await writer(); else await parent();
