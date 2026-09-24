import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestEnv } from './helpers/test-env.js';
import { runIfMain } from './helpers/run-if-main.js';

// #697: Desktop Commander 0.2.48 and older write config.json in place, so the
// file is empty from the moment the writer opens it until its content lands.
// Measured with 0.2.46 serving tool calls beside the current build: empty for
// up to ~260ms on Windows and ~60ms on macOS. A process reading config.json in
// that window must wait for the content. Failing instead is what the issue
// reports: `-32603 Unexpected end of JSON input` from the onboarding write
// inside `initialize`, and a flood of "Failed to reload config".

const TEST_FILE = fileURLToPath(import.meta.url);
const EMPTY_MS = 300; // longer than any empty window measured
const TIMEOUT_MS = 5_000;
const KEY = '__readMidWriteTest';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function worker() {
  let reloadErrors = [];
  const logError = console.error;
  console.error = (...args) => {
    if (String(args[0]).includes('Failed to reload config')) reloadErrors.push(String(args[1]?.message ?? args[1]));
    logError(...args);
  };
  const { configManager } = await import('../dist/config-manager.js');
  await configManager.getConfig();
  process.send?.({ type: 'ready' });
  process.on('message', async (message) => {
    if (message.type === 'set') {
      try {
        await configManager.setValue(KEY, message.value);
        process.send?.({ type: 'set-done' });
      } catch (error) {
        process.send?.({ type: 'set-done', error: error.message });
      }
    } else if (message.type === 'watch') {
      reloadErrors = [];
      process.send?.({ type: 'watching' });
      const deadline = Date.now() + TIMEOUT_MS;
      while (Date.now() < deadline && await configManager.getValue('writtenBy') !== message.value) await sleep(20);
      process.send?.({ type: 'observed', value: await configManager.getValue('writtenBy'), reloadErrors });
    }
  });
}

function waitFor(child, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), TIMEOUT_MS + 500);
    const onMessage = (message) => {
      if (message.type !== type) return;
      clearTimeout(timer); child.off('message', onMessage);
      resolve(message);
    };
    child.on('message', onMessage);
  });
}

// What an older version does: open with truncate (the file is now empty),
// and write the whole content a moment later
async function writeInPlaceLikeOldVersion(configPath, config) {
  writeFileSync(configPath, '');
  await sleep(EMPTY_MS);
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

if (process.env.DC_MID_WRITE_WORKER === '1') {
  await worker();
} else await runIfMain(import.meta.url, async () => {
  const { env, home, cleanup } = createTestEnv();
  const configPath = path.join(home, '.claude-server-commander', 'config.json');
  const config = { telemetryEnabled: false, welcomeOnboardingEligible: false, pendingWelcomeOnboarding: false, writtenBy: 'initial' };
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  const child = fork(TEST_FILE, [], { env: { ...env, HOME: home, USERPROFILE: home, DC_MID_WRITE_WORKER: '1' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const failures = [];
  const check = async (name, run) => {
    try { await run(); console.log(`✓ ${name}`); }
    catch (error) { failures.push(name); console.log(`✗ ${name}
  ${error.message}`); }
  };
  try {
    await waitFor(child, 'ready');

    // A config write (like the onboarding write inside `initialize`) while
    // another version is writing config.json
    await check('a config write waits for another version to finish writing config.json', async () => {
      const setDone = waitFor(child, 'set-done');
      const oldWrite = writeInPlaceLikeOldVersion(configPath, { ...config, writtenBy: 'older-version' });
      child.send({ type: 'set', value: 'set-during-old-write' });
      const set = await setDone;
      await oldWrite;
      assert.equal(set.error, undefined, `a config write while another version was writing config.json failed: ${set.error}`);
      const onDisk = JSON.parse(readFileSync(configPath, 'utf8'));
      assert.equal(onDisk[KEY], 'set-during-old-write', 'the write must land');
      assert.equal(onDisk.writtenBy, 'older-version', 'the write must keep what the other version wrote, not overwrite it');
    });

    // A running process reloading config while another version writes it
    await check('a running process reloads config written by another version without errors', async () => {
      const watching = waitFor(child, 'watching');
      const observed = waitFor(child, 'observed');
      child.send({ type: 'watch', value: 'older-version-again' });
      await watching;
      await writeInPlaceLikeOldVersion(configPath, { ...config, writtenBy: 'older-version-again' });
      const reload = await observed;
      assert.equal(reload.value, 'older-version-again', 'the running process must pick up what the other version wrote');
      assert.deepEqual(reload.reloadErrors, [], `"Failed to reload config" while another version was writing config.json: ${reload.reloadErrors.join('; ')}`);
    });
    assert.deepEqual(failures, [], `${failures.length} of 2 cases failed`);
  } finally {
    const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
    cleanup();
  }
});
