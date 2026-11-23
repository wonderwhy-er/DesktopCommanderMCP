import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
// Each wait ends when its message arrives (a start, a write, a reload: well
// under 2 s here); this much holds up on a loaded machine
const TIMEOUT_MS = 30_000;
const KEY = '__readMidWriteTest';
const FREEZE_MS = 1_100; // longer than the one-second wait for a half-written file
// The config manager waits out a file that doesn't parse for at least 1 s. On a
// loaded machine the EMPTY_MS sleep can run late and leave config.json empty
// for longer than that, which is no fault of the product's. A case whose window
// was longer than this and that failed runs again, up to ATTEMPTS times; one
// with a shorter window fails at once
const FAIR_WINDOW_MS = 800;
const ATTEMPTS = 3;
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

// A process starting while another version is writing config.json: it says when
// its first read is about to happen, then reports what it read
async function startupWorker() {
  const initErrors = [];
  const logError = console.error;
  console.error = (...args) => {
    if (String(args[0]).includes('Failed to initialize config')) initErrors.push(String(args[1]?.message ?? args[1]));
    logError(...args);
  };
  const { configManager } = await import('../dist/config-manager.js');
  process.send?.({ type: 'about-to-read' });
  // How long it found config.json empty, as this process saw it
  const readStarted = Date.now();
  await configManager.getConfig();
  const readMs = Date.now() - readStarted;
  process.send?.({ type: 'started', value: await configManager.getValue('writtenBy'), initErrors, readMs });
}

// A start that freezes (loading modules, a busy machine) while another version
// writes config.json: its first two reads find the file empty, with a freeze
// longer than the wait between them; the third finds it whole
async function freezeWorker() {
  const initErrors = [];
  const logError = console.error;
  console.error = (...args) => {
    if (String(args[0]).includes('Failed to initialize config')) initErrors.push(String(args[1]?.message ?? args[1]));
    logError(...args);
  };
  const { promises: fsPromises } = await import('node:fs');
  const readFile = fsPromises.readFile;
  let reads = 0;
  fsPromises.readFile = async function (file, ...rest) {
    if (!String(file).endsWith('config.json') || ++reads > 2) return readFile.call(this, file, ...rest);
    if (reads === 1) setTimeout(() => { for (const until = Date.now() + FREEZE_MS; Date.now() < until;); }, 0);
    return rest.length > 0 ? '' : Buffer.alloc(0);
  };
  const { configManager } = await import('../dist/config-manager.js');
  await configManager.getConfig();
  process.send?.({ type: 'started', value: await configManager.getValue('writtenBy'), initErrors });
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
// and write the whole content a moment later. Resolves with how long the file was empty
async function writeInPlaceLikeOldVersion(configPath, config) {
  const emptied = Date.now();
  writeFileSync(configPath, '');
  await sleep(EMPTY_MS);
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return Date.now() - emptied;
}

/**
 * Runs a case: `attempt(n)` leaves config.json empty for a while and resolves
 * with { emptyMs, verify }, how long it was empty and the case's checks. When
 * the checks fail after a window longer than FAIR_WINDOW_MS, the case runs again.
 */
async function withFairWindow(attempt) {
  for (let n = 1; ; n++) {
    const { emptyMs, verify } = await attempt(n);
    try {
      return verify();
    } catch (error) {
      if (emptyMs <= FAIR_WINDOW_MS) throw error;
      if (n === ATTEMPTS) {
        error.message += ` (config.json was empty for over ${FAIR_WINDOW_MS}ms in all ${ATTEMPTS} attempts, ${emptyMs}ms the last time: the machine was too loaded to tell)`;
        throw error;
      }
      console.log(`  attempt ${n}: config.json was empty for ${emptyMs}ms, longer than the config manager waits; again`);
    }
  }
}

if (process.env.DC_MID_WRITE_WORKER === '1') {
  await worker();
} else if (process.env.DC_MID_WRITE_WORKER === 'startup') {
  await startupWorker();
} else if (process.env.DC_MID_WRITE_WORKER === 'freeze') {
  await freezeWorker();
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
    await check('a config write waits for another version to finish writing config.json', () => withFairWindow(async (attempt) => {
      // Values of this attempt's own, so a retry can't pass on what an earlier one left
      const value = `set-during-old-write-${attempt}`;
      const writtenBy = `older-version-${attempt}`;
      const setDone = waitFor(child, 'set-done');
      const oldWrite = writeInPlaceLikeOldVersion(configPath, { ...config, writtenBy });
      child.send({ type: 'set', value });
      const set = await setDone;
      const emptyMs = await oldWrite;
      return {
        emptyMs,
        verify: () => {
          assert.equal(set.error, undefined, `a config write while another version was writing config.json failed: ${set.error}`);
          const onDisk = JSON.parse(readFileSync(configPath, 'utf8'));
          assert.equal(onDisk[KEY], value, 'the write must land');
          assert.equal(onDisk.writtenBy, writtenBy, 'the write must keep what the other version wrote, not overwrite it');
        },
      };
    }));

    // A running process reloading config while another version writes it
    await check('a running process reloads config written by another version without errors', () => withFairWindow(async (attempt) => {
      const writtenBy = `older-version-again-${attempt}`;
      const watching = waitFor(child, 'watching');
      const observed = waitFor(child, 'observed');
      child.send({ type: 'watch', value: writtenBy });
      await watching;
      const emptyMs = await writeInPlaceLikeOldVersion(configPath, { ...config, writtenBy });
      const reload = await observed;
      return {
        emptyMs,
        verify: () => {
          assert.equal(reload.value, writtenBy, 'the running process must pick up what the other version wrote');
          assert.deepEqual(reload.reloadErrors, [], `"Failed to reload config" while another version was writing config.json: ${reload.reloadErrors.join('; ')}`);
        },
      };
    }));

    // A process starting while another version writes config.json: its first read
    // must wait for the content, not fall back to the defaults (which it does
    // silently: the server still answers). In its own home, away from the child above.
    await check('a process starting while another version writes config.json reads the finished config', () => withFairWindow(async () => {
      const started = createTestEnv();
      const startPath = path.join(started.home, '.claude-server-commander', 'config.json');
      mkdirSync(path.dirname(startPath), { recursive: true });
      writeFileSync(startPath, ''); // the other version has opened it with truncate
      const starter = fork(TEST_FILE, [], { env: { ...started.env, HOME: started.home, USERPROFILE: started.home, DC_MID_WRITE_WORKER: 'startup' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      try {
        const result = waitFor(starter, 'started');
        await waitFor(starter, 'about-to-read');
        await sleep(EMPTY_MS);
        writeFileSync(startPath, JSON.stringify({ ...config, writtenBy: 'older-version-at-start' }, null, 2));
        // The window as the starting process saw it: from its first read, which
        // this process hears of only later
        const { value, initErrors, readMs } = await result;
        return {
          emptyMs: readMs,
          verify: () => {
            assert.deepEqual(initErrors, [], `"Failed to initialize config" while another version was writing config.json: ${initErrors.join('; ')}`);
            assert.equal(value, 'older-version-at-start', 'the process must start with what the other version wrote, not the defaults');
          },
        };
      } finally {
        const exited = starter.exitCode !== null || starter.signalCode !== null ? Promise.resolve() : new Promise((resolve) => starter.once('exit', resolve));
        starter.kill('SIGTERM');
        await exited;
        started.cleanup();
      }
    }));
    // The same, with a freeze that spends the one-second wait between two reads
    // of the empty file: the freeze is no time the file was seen half-written
    await check('a start that freezes while another version writes config.json still reads the finished config', async () => {
      const started = createTestEnv();
      const configDir = path.join(started.home, '.claude-server-commander');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ ...config, writtenBy: 'older-version-after-freeze' }, null, 2));
      const starter = fork(TEST_FILE, [], { env: { ...started.env, HOME: started.home, USERPROFILE: started.home, DC_MID_WRITE_WORKER: 'freeze' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      try {
        const { value, initErrors } = await waitFor(starter, 'started');
        assert.deepEqual(initErrors, [], `"Failed to initialize config" after a freeze: ${initErrors.join('; ')}`);
        assert.equal(value, 'older-version-after-freeze', 'the process must start with what the other version wrote, not the defaults');
        assert.deepEqual(readdirSync(configDir).filter((name) => name.startsWith('config.json.corrupt.')), [], 'config.json must not be replaced as damaged');
      } finally {
        const exited = starter.exitCode !== null || starter.signalCode !== null ? Promise.resolve() : new Promise((resolve) => starter.once('exit', resolve));
        starter.kill('SIGTERM');
        await exited;
        started.cleanup();
      }
    });
    assert.deepEqual(failures, [], `${failures.length} of 4 cases failed`);
  } finally {
    const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
    cleanup();
  }
});
