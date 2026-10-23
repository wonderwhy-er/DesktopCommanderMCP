#!/usr/bin/env node

/**
 * `remote --logout` revokes server access and removes the saved credentials. A
 * device that is still stopping may hold its session in memory, but must not write the
 * file back, or the next start restores the session instead of asking to log
 * in. (The rotation and shutdown saves are covered by
 * test/integration/remote-device-restart.js.) Here:
 *
 * - a logout while the device starts, after it loaded device.json and before
 *   its first save: that save used to write the file back, because the device
 *   only took a missing file for a logout once it had saved it itself
 * - a logout while the device saves: it used to check that device.json was
 *   still there, then read its session and write, and a logout in between was
 *   undone. The save's check and write and the logout's removal now take a
 *   lock on device.json (proper-lockfile), so they happen one after the other.
 * - a login after the logout, while the logged-out device still runs: its
 *   device.json passed the check that the file was still there, and the old
 *   device's next save wrote the old credentials over it. The save now checks
 *   that the file still holds what this run last loaded or saved.
 *
 * Real `remote --logout` processes, a real device process against the local
 * stand-in (helpers/remote-stand-in.js), and an MCPDevice in this process.
 *
 * Runs as part of `npm test`, or standalone:
 *   node test/run-all-tests.js test/test-remote-device-logout.js
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { MCPDevice } from '../dist/remote-device/device.js';
import { deviceConfigPath, runLogout, startDevice, stopHard, tail, waitFor, writeDeviceConfig } from './helpers/remote-device.js';
import { startRemoteStandIn } from './helpers/remote-stand-in.js';
import { createTestEnv, isTestHome } from './helpers/test-env.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

/** A start (local MCP child, session, device lookup) takes seconds; this is far above */
const START_DEADLINE_MS = 60_000;
/** How long the test holds the lock a device's save holds for milliseconds */
const LOCK_HELD_MS = 1500;

/** Resolves with `promise`'s value, or `timedOut` after `ms` */
async function within(promise, ms, timedOut) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve) => { timer = setTimeout(() => resolve(timedOut), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runTests() {
  if (!isTestHome()) {
    skip('test-remote-device-logout.js runs a device in this process: run it through node test/run-all-tests.js');
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

  await test('remote --logout waits for a save in progress instead of removing device.json in the middle of it', async ({ standIn, env, home }) => {
    writeDeviceConfig(home, { deviceId: standIn.deviceId, session: standIn.login() });
    // What a device's save holds while it checks that device.json is still there and writes it
    const release = await lockfile.lock(deviceConfigPath(home), { realpath: false });
    let logout;
    try {
      logout = runLogout(env);
      const endedWhileHeld = await within(logout.then(() => true), LOCK_HELD_MS, false);
      assert.ok(!endedWhileHeld && fs.existsSync(deviceConfigPath(home)),
        'remote --logout removed device.json while a device was saving it (between its check that the file is still '
        + 'there and its write), so that save writes the credentials back and the logout does not stick');
    } finally {
      await release();
    }
    const { code, output } = await logout;
    assert.ok(code === 0 && !fs.existsSync(deviceConfigPath(home)),
      `once the save was done, remote --logout should have removed device.json (exit ${code}):\n${tail(output)}`);
  });

  await test('a logout that lands while the device reads the session to save is not undone', async ({ standIn, env, home }) => {
    const configPath = deviceConfigPath(home);
    writeDeviceConfig(home, { deviceId: standIn.deviceId, session: standIn.login() });
    const device = new MCPDevice();
    device.configPath = configPath;
    await device.loadPersistedConfig();
    const rc = device.remoteChannel;
    rc.getSession = async () => ({ data: { session: standIn.login() } });
    await device.savePersistedConfig(); // the device has saved device.json this run
    assert.ok(fs.existsSync(configPath), 'setup: the first save should have written device.json');

    // getSession() can take seconds (a lock, a refresh over the network)
    let logout;
    rc.getSession = async () => {
      logout = await runLogout(env);
      await sleep(50);
      return { data: { session: { access_token: 'a2', refresh_token: 'r2' } } };
    };
    await device.savePersistedConfig();

    assert.ok(!fs.existsSync(configPath),
      'remote --logout ran while the device was reading its session for a save (after it had checked that device.json '
      + `was still there, exit ${logout?.code}), and the save wrote device.json back: the logout did not stick`);
  });

  await test('logout before the first ever save prevents credentials from being created', async ({ env, home }) => {
    const device = new MCPDevice();
    device.configPath = deviceConfigPath(home);
    device.deviceId = 'device-1';
    device.remoteChannel.getSession = async () => {
      const logout = await runLogout(env);
      assert.equal(logout.code, 0, logout.output);
      return { data: { session: { access_token: 'a', refresh_token: 'r' } } };
    };
    await device.savePersistedConfig();
    assert.ok(!fs.existsSync(device.configPath), 'the first save must not undo logout');
  });

  await test('logout revokes the device, removes all local credentials, and requires fresh pairing', async ({ standIn, env, home, start }) => {
    const configPath = deviceConfigPath(home);
    const folder = path.join(path.dirname(configPath), '.mqtt');
    {
      writeDeviceConfig(home, { deviceId: standIn.deviceId, session: standIn.login() });
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, 'identity.json'), JSON.stringify({ private_key: 'synthetic-secret' }));
      fs.writeFileSync(path.join(folder, 'certificate.json'), '{}');
      fs.writeFileSync(path.join(folder, 'unrelated.txt'), 'keep');
      const logout = await runLogout(env);
      assert.equal(logout.code, 0, logout.output);
      for (const file of [configPath, path.join(folder, 'identity.json'), path.join(folder, 'certificate.json')]) {
        assert.ok(!fs.existsSync(file), `logout left ${file}`);
      }
      assert.equal(fs.readFileSync(path.join(folder, 'unrelated.txt'), 'utf8'), 'keep');
      assert.match(logout.output, /Saved device and MQTT credentials were removed/);
      assert.deepEqual(standIn.revocations, [standIn.deviceId]);
    }
    assert.equal((await runLogout(env)).code, 0);
    const restarted = start();
    await waitFor(restarted, () => standIn.deviceFlowRequests > 0, START_DEADLINE_MS);
    assert.ok(standIn.deviceFlowRequests > 0, 'the next start must enter device identification again');
  });

  await test('a credential deletion failure is reported and releases the locks for a retry', async ({ standIn, env, home }) => {
    writeDeviceConfig(home, { deviceId: standIn.deviceId, session: standIn.login() });
    const identity = path.join(path.dirname(deviceConfigPath(home)), '.mqtt', 'identity.json');
    fs.mkdirSync(identity, { recursive: true }); // A malformed cache path that rm(file) cannot delete
    const failed = await runLogout(env);
    assert.equal(failed.code, 1, failed.output);
    assert.match(failed.output, /Logout did not complete/);
    assert.doesNotMatch(failed.output, /Logged out\./);
    fs.rmdirSync(identity);
    const retried = await runLogout(env);
    assert.equal(retried.code, 0, retried.output);
  });

  await test('failed or unconfirmed revocation keeps every credential for retry', async ({ standIn, env, home }) => {
    const configPath = deviceConfigPath(home);
    const folder = path.join(path.dirname(configPath), '.mqtt');
    writeDeviceConfig(home, { deviceId: standIn.deviceId, session: standIn.login() });
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'identity.json'), 'private-key-fixture');
    fs.writeFileSync(path.join(folder, 'certificate.json'), 'certificate-fixture');
    const before = fs.readFileSync(configPath, 'utf8');
    for (const status of [502, 404, 200]) {
      standIn.revokeStatus = status;
      standIn.confirmMqttRevocation = false;
      const logout = await runLogout(env);
      assert.equal(logout.code, 1, logout.output);
      assert.equal(fs.readFileSync(configPath, 'utf8'), before);
      assert.equal(fs.readFileSync(path.join(folder, 'identity.json'), 'utf8'), 'private-key-fixture');
      assert.equal(fs.readFileSync(path.join(folder, 'certificate.json'), 'utf8'), 'certificate-fixture');
      assert.doesNotMatch(logout.output, /Logged out\./);
    }
    standIn.confirmMqttRevocation = true;
    assert.equal((await runLogout(env)).code, 0);
  });

  await test('logout refreshes an expired session and keeps the rotated token if revocation fails', async ({ standIn, env, home }) => {
    const session = standIn.login({ accessExpiresInSec: -60 });
    writeDeviceConfig(home, { deviceId: standIn.deviceId, session });
    standIn.revokeStatus = 502;
    const failed = await runLogout(env);
    assert.equal(failed.code, 1, failed.output);
    const saved = JSON.parse(fs.readFileSync(deviceConfigPath(home), 'utf8'));
    assert.notEqual(saved.session.refresh_token, session.refresh_token);
    standIn.revokeStatus = 200;
    const logout = await runLogout(env);
    assert.equal(logout.code, 0, logout.output);
    assert.ok(!fs.existsSync(deviceConfigPath(home)));
    assert.deepEqual(standIn.revocations, [standIn.deviceId]);
  });

  await test('a login after the logout is not written over by the device that was logged out', async ({ standIn, env, home }) => {
    const configPath = deviceConfigPath(home);
    writeDeviceConfig(home, { deviceId: standIn.deviceId, session: standIn.login() });
    const device = new MCPDevice();
    device.configPath = configPath;
    await device.loadPersistedConfig();
    const rc = device.remoteChannel;
    rc.getSession = async () => ({ data: { session: standIn.login() } });
    await device.savePersistedConfig(); // the device has saved device.json this run

    const logout = await runLogout(env);
    assert.ok(!fs.existsSync(configPath), `setup: remote --logout did not remove device.json (exit ${logout.code}):\n${tail(logout.output)}`);
    // A new `remote` logs in and saves its own device (the old device still runs)
    const newLogin = { deviceId: 'device-2', session: { access_token: 'b0', refresh_token: 'rb0' } };
    writeDeviceConfig(home, newLogin);

    // The old device's next save: a token rotation, or its shutdown
    rc.getSession = async () => ({ data: { session: { access_token: 'a2', refresh_token: 'r2' } } });
    await device.savePersistedConfig();

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepStrictEqual(onDisk, newLogin,
      'the device logged out by remote --logout wrote its credentials over the device.json a new login saved after '
      + 'the logout, so the next start restores the old device instead of the new one');
  });

  console.log(`\n${failures.length ? '🔴' : '✅'} remote device logout: ${failures.length} failing test(s).`);
  return failures.length === 0;
}

runIfMain(import.meta.url, runTests);
