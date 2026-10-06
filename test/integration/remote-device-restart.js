#!/usr/bin/env node

/**
 * Regression test for DC-695 (#695): a headless remote device must survive a
 * restart after its refresh token has rotated, reconnecting from
 * ~/.desktop-commander-device/device.json alone. A device-code flow is no way
 * back on a server: nobody is there to open the link.
 *
 * Reported on 0.2.50 (systemd, Restart=always): auth-js rotates the refresh
 * token on every refresh, the device kept the rotated pair in memory only, and
 * device.json kept the token from login. GoTrue accepts the token just before
 * the current one but nothing older, so the first restart after two rotations
 * replayed a spent token:
 *
 *     Failed to set session: Invalid Refresh Token: Already Used
 *     -> device-code flow -> "Device code has expired" -> exit 1 -> restart -> ...
 *
 * 0.2.51 (08ff761, #710) persists every rotation: TOKEN_REFRESHED ->
 * RemoteChannel.onSessionRefreshed -> MCPDevice.savePersistedConfig(). These
 * cases check the reporter's scenario end to end: real device processes
 * (dist/remote-device/device.js), each started with nothing but the home the
 * previous one left, against a local stand-in (test/helpers/remote-stand-in.js)
 * whose GoTrue rotates refresh tokens and refuses reuse the way GoTrue does.
 *
 * Rotations: the stand-in's access tokens live 95 s. auth-js refreshes a token
 * within 90 s of its expiry whenever the device reads its session (every REST
 * request), so a running device rotates every few seconds rather than every 45
 * minutes, through the same auth-js refresh and TOKEN_REFRESHED event.
 *
 * The other cases are the card's other ways a spent token could end up on
 * disk, each followed by a restart:
 *   - a start that refreshes (and so rotates) the token, then fails before
 *     saving it, twice in a row: a Restart=always loop on a flaky network
 *   - the shutdown script (blocking-offline-update.js) refreshing the token it
 *     was handed and keeping nothing
 *   - a refresh refused once: auth-js drops the session, the device restores it
 *
 * And the other way round: `remote --logout` while the device runs must stick.
 * The device keeps running on its session, but must not write device.json back
 * at its next rotation or at shutdown, so the next start asks to log in.
 *
 * Real processes and real rotations take 40-50 s, so this runs with the
 * integration tests: `npm run test:integration`, or alone:
 *   npm run build && node test/integration/run-all-integration-tests.js remote-device-restart.js
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STARTED, deviceConfigPath, runLogout, startDevice, stopGracefully, stopHard, tail, waitFor, writeDeviceConfig,
} from '../helpers/remote-device.js';
import { startRemoteStandIn } from '../helpers/remote-stand-in.js';
import { createTestEnv } from '../helpers/test-env.js';
import { runIfMain, skip } from '../helpers/run-if-main.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OFFLINE_UPDATE = path.join(PROJECT_ROOT, 'dist/remote-device/scripts/blocking-offline-update.js');

/** auth-js refreshes these 5 s after they are issued (its margin is 90 s) */
const ROTATING_ACCESS_TTL_SEC = 95;
/** A start (local MCP child, session, registration) takes seconds; this is far above */
const START_DEADLINE_MS = 60_000;
/** Two rotations of a running device take well under a minute here */
const ROTATION_DEADLINE_MS = 120_000;
/** A device that stops on its own (failed start) is gone within its 5 s shutdown limit */
const EXIT_DEADLINE_MS = 30_000;

const readPersistedSession = (home) => JSON.parse(fs.readFileSync(deviceConfigPath(home), 'utf8')).session;

/** What a completed device authorization leaves in the home */
function writeLoggedInHome(home, standIn, session) {
  writeDeviceConfig(home, { deviceId: standIn.deviceId, session });
}

async function expectStarted(device, standIn, what) {
  await waitFor(device, () => STARTED.test(device.output), START_DEADLINE_MS);
  assert.ok(STARTED.test(device.output),
    `setup: ${what} did not get through its start (${standIn.describe()}). Its output:\n${tail(device.output)}`);
}

/**
 * The user's outcome: the restarted device restores its session and gets
 * through its start, without the device-code flow and without GoTrue ever
 * seeing a spent refresh token.
 */
async function expectReconnected(device, standIn, what) {
  await waitFor(device, () => STARTED.test(device.output), START_DEADLINE_MS);
  const problems = [];
  if (standIn.refreshes.some((r) => r.outcome === 'already-used')) {
    problems.push('GoTrue answered "Invalid Refresh Token: Already Used"');
  }
  if (standIn.deviceFlowRequests > 0 || /Authenticating with Remote MCP server/.test(device.output)) {
    problems.push('it fell back to the device-code flow, which nobody completes on a headless host');
  }
  if (!/Session restored/.test(device.output)) problems.push('it never restored its saved session');
  if (!STARTED.test(device.output)) {
    problems.push(device.exited ? `it exited (code ${device.code})` : 'it did not get through its start');
  }
  assert.ok(problems.length === 0,
    `after ${what}, the device did not reconnect on its own: ${problems.join('; ')}.\n`
    + `    Stand-in: ${standIn.describe()}\n    Its output:\n${tail(device.output)}`);
  console.log(`   reconnected after ${what}\n   stand-in: ${standIn.describe()}`);
}

/** Lets a running device rotate its refresh token `count` more times */
async function rotateWhileRunning(device, standIn, count) {
  const target = standIn.rotations() + count;
  await waitFor(device, () => standIn.rotations() >= target, ROTATION_DEADLINE_MS);
  assert.ok(standIn.rotations() >= target && !device.exited,
    `setup: the running device did not rotate its token ${count} time(s) (${standIn.describe()}). Its output:\n${tail(device.output)}`);
}

/** Which of the session's refresh tokens device.json holds, for messages */
function persistedGeneration(home, standIn) {
  const saved = readPersistedSession(home)?.refresh_token;
  return `device.json holds token ${standIn.generationOf(saved)}, GoTrue's current is ${standIn.currentGeneration(saved)}`;
}

async function runTests() {
  const failures = [];

  async function test(name, fn) {
    const standIn = await startRemoteStandIn();
    const testEnv = createTestEnv();
    const env = { ...testEnv.env, MCP_SERVER_URL: standIn.url };
    const devices = [];
    const start = (args) => {
      const device = startDevice(env, args);
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

  async function restartAfterRotations(stop, { standIn, home, start }) {
    standIn.accessTtlSec = ROTATING_ACCESS_TTL_SEC;
    writeLoggedInHome(home, standIn, standIn.login());

    const running = start();
    await expectStarted(running, standIn, 'the first start, right after login');
    await rotateWhileRunning(running, standIn, 2);
    await stop(running);

    const rotations = standIn.rotations();
    const saved = persistedGeneration(home, standIn);
    await expectReconnected(start(), standIn, `${rotations} rotations and a restart (${saved})`);
  }

  await test('a device restarted after its refresh token rotated reconnects without a browser (killed)', (context) =>
    restartAfterRotations(stopHard, context));

  if (process.platform === 'win32') {
    skip('restart after SIGTERM: a signal cannot stop a Windows process gracefully; the killed case covers Windows');
  } else {
    await test('a device restarted after its refresh token rotated reconnects without a browser (SIGTERM, as systemctl restart)', (context) =>
      restartAfterRotations(stopGracefully, context));
  }

  await test('starts that rotate the token and then fail do not lock the device out', async ({ standIn, home, start }) => {
    // Down longer than the access token lives: each start refreshes, and so
    // rotates, before it looks the device up
    writeLoggedInHome(home, standIn, standIn.login({ accessExpiresInSec: -60 }));
    standIn.failDeviceLookups(2 * 3); // two starts give up on the lookup, 3 attempts each

    for (const attempt of [1, 2]) {
      const failing = start();
      await waitFor(failing, () => false, EXIT_DEADLINE_MS);
      assert.ok(failing.exited && failing.code === 1 && /Device startup failed/.test(failing.output),
        `setup: start ${attempt} was meant to fail on the device lookup (${standIn.describe()}). Its output:\n${tail(failing.output)}`);
    }

    const saved = persistedGeneration(home, standIn);
    await expectReconnected(start(), standIn, `two starts that rotated the token and then failed (${saved})`);
  });

  await test('the shutdown script refreshing the token does not lock the device out', async ({ standIn, env, home, start }) => {
    // What setOffline() hands the script on a machine that just woke: the
    // cached session, whose access token has expired, when getSession() does
    // not answer within 500 ms. The script refreshes it and keeps nothing.
    const session = standIn.login({ accessExpiresInSec: -60 });
    writeLoggedInHome(home, standIn, session);
    const script = spawn(process.execPath, [OFFLINE_UPDATE, standIn.deviceId, standIn.url, standIn.anonKey, session.access_token, session.refresh_token], {
      cwd: PROJECT_ROOT, env, stdio: 'ignore', windowsHide: true,
    });
    const code = await new Promise((resolve) => script.on('exit', resolve));
    assert.ok(standIn.rotations() === 1,
      `setup: the shutdown script was meant to refresh the saved token (exit ${code}; ${standIn.describe()})`);

    const saved = persistedGeneration(home, standIn);
    await expectReconnected(start(), standIn, `the shutdown script rotated the saved token (${saved})`);
  });

  await test('a refresh refused once (auth-js drops the session) does not lock the device out', async ({ standIn, home, start }) => {
    standIn.accessTtlSec = ROTATING_ACCESS_TTL_SEC;
    writeLoggedInHome(home, standIn, standIn.login());

    const running = start();
    await expectStarted(running, standIn, 'the first start, right after login');
    // auth-js treats a 500 as final: it drops the session and emits SIGNED_OUT
    standIn.failRefreshes(1, 500);
    const restored = /Remote session restored after a transient sign-out/;
    await waitFor(running, () => restored.test(running.output), ROTATION_DEADLINE_MS);
    assert.ok(restored.test(running.output),
      `setup: the device was meant to restore its session after one refused refresh (${standIn.describe()}). Its output:\n${tail(running.output)}`);
    await rotateWhileRunning(running, standIn, 1);
    await stopHard(running);

    const saved = persistedGeneration(home, standIn);
    await expectReconnected(start(), standIn, `a refused refresh, a restore and a restart (${saved})`);
  });

  await test('a logout while the device runs sticks: device.json is not written back', async ({ standIn, env, home, start }) => {
    standIn.accessTtlSec = ROTATING_ACCESS_TTL_SEC;
    writeLoggedInHome(home, standIn, standIn.login());

    const running = start();
    await expectStarted(running, standIn, 'the first start, right after login'); // it has saved device.json by then
    const logout = await runLogout(env);
    const sinceLogout = running.output.length;
    assert.ok(!fs.existsSync(deviceConfigPath(home)),
      `setup: remote --logout did not remove device.json (exit ${logout.code}):
${tail(logout.output)}`);

    // The device keeps running on its session: it rotates it, then stops
    // (gracefully where a signal can do that, as systemctl stop does). The
    // rotation's save runs just after it: wait for its outcome in the output,
    // a write or the note that the credentials were removed.
    await rotateWhileRunning(running, standIn, 1);
    const saveOutcome = /Config saved to|credentials were removed/;
    await waitFor(running, () => saveOutcome.test(running.output.slice(sinceLogout)), START_DEADLINE_MS);
    const afterRotation = fs.existsSync(deviceConfigPath(home));
    await (process.platform === 'win32' ? stopHard : stopGracefully)(running);
    const afterStop = fs.existsSync(deviceConfigPath(home));

    const restarted = start();
    await waitFor(restarted, () => STARTED.test(restarted.output) || standIn.deviceFlowRequests > 0, START_DEADLINE_MS);
    const askedToLogIn = standIn.deviceFlowRequests > 0;
    assert.ok(!afterRotation && !afterStop && askedToLogIn,
      'after remote --logout, the running device wrote device.json back '
      + `(after its next token refresh: ${afterRotation ? 'back' : 'gone'}; after it stopped: ${afterStop ? 'back' : 'gone'}), `
      + `so the logout did not stick: the next start ${askedToLogIn ? 'asked' : 'did not ask'} to log in.
`
      + `    Stand-in: ${standIn.describe()}
    The running device's output:
${tail(running.output)}`);
  });

  console.log(`\n${failures.length ? '🔴' : '✅'} remote device restart: ${failures.length} failing test(s).`);
  return failures.length === 0;
}

runIfMain(import.meta.url, runTests);
