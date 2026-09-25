#!/usr/bin/env node

/**
 * `remote --logout` removes device.json, the saved Remote MCP credentials. A
 * device that is running keeps its session in memory, but must not write the
 * file back, or the next start restores the session instead of asking to log
 * in. (The rotation and shutdown saves are covered by
 * test/integration/remote-device-restart.js.)
 *
 * Here: a logout while the device starts, after it loaded device.json and
 * before its first save. That save used to write the file back, because the
 * device only took a missing file for a logout once it had saved it itself.
 *
 * A real `remote --logout` process and a real device process against the
 * local stand-in (helpers/remote-stand-in.js).
 *
 * Runs as part of `npm test`, or standalone:
 *   node test/run-all-tests.js test/test-remote-device-logout.js
 */
import assert from 'node:assert';
import fs from 'node:fs';
import { deviceConfigPath, runLogout, startDevice, stopHard, tail, waitFor, writeDeviceConfig } from './helpers/remote-device.js';
import { startRemoteStandIn } from './helpers/remote-stand-in.js';
import { createTestEnv, isTestHome } from './helpers/test-env.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

/** A start (local MCP child, session, device lookup) takes seconds; this is far above */
const START_DEADLINE_MS = 60_000;

/** Resolves with `promise`'s value, or `timedOut` after `ms` */
async function within(promise, ms, timedOut) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve) => { timer = setTimeout(() => resolve(timedOut), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

async function runTests() {
  if (!isTestHome()) {
    skip('test-remote-device-logout.js writes to the home: run it through node test/run-all-tests.js');
    return true;
  }
  const failures = [];

  async function test(name, fn) {
    const standIn = await startRemoteStandIn();
    const testEnv = createTestEnv();
    const env = { ...testEnv.env, MCP_SERVER_URL: standIn.url };
    const devices = [];
    const start = () => {
      const device = startDevice(env);
      devices.push(device);
      return device;
    };
    try {
      await fn({ standIn, env, home: testEnv.home, start });
      console.log(`✅ ${name}`);
    } catch (error) {
      failures.push(name);
      console.log(`❌ ${name}\n   ${error.message}`);
    } finally {
      for (const device of devices) await stopHard(device);
      await standIn.close();
      try {
        testEnv.cleanup();
      } catch (error) {
        console.log(`   (could not remove ${testEnv.home}: ${error.message})`);
      }
    }
  }

  await test('a logout while the device starts sticks: its first save does not write device.json back', async ({ standIn, env, home, start }) => {
    writeDeviceConfig(home, { deviceId: standIn.deviceId, session: standIn.login() });
    const hold = standIn.holdDeviceLookups();
    const device = start();
    assert.ok(await within(hold.reached.then(() => true), START_DEADLINE_MS, false),
      `setup: the device never looked its saved device up:\n${tail(device.output)}`);

    const logout = await runLogout(env);
    assert.ok(!fs.existsSync(deviceConfigPath(home)),
      `setup: remote --logout did not remove device.json (exit ${logout.code}):\n${tail(logout.output)}`);
    hold.release();
    await waitFor(device, () => /Config saved to|credentials were removed/.test(device.output), START_DEADLINE_MS);

    assert.ok(!fs.existsSync(deviceConfigPath(home)),
      'remote --logout while the device was starting (after it loaded device.json, before its first save) did not '
      + 'stick: the device wrote device.json back, so the next start restores the session instead of asking to log in. '
      + `Its output:\n${tail(device.output)}`);
  });

  console.log(`\n${failures.length ? '🔴' : '✅'} remote device logout: ${failures.length} failing test(s).`);
  return failures.length === 0;
}

runIfMain(import.meta.url, runTests);
