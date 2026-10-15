#!/usr/bin/env node

/**
 * A device.json with a session but no device id must count as not logged in:
 * the device asks for authorization, as it does with no session at all.
 *
 * Before, the device restored such a session. That skips the check for a
 * revoked device (it runs only with an id), and registration then looks a
 * device up with no id: "Device not found: undefined", exit 1, on every start.
 * Under systemd's Restart=always that repeats on every restart without the
 * device ever asking to log in again, and the save at the end of start()
 * writes the same shape back, so only deleting the file by hand ends it. How
 * such a file comes about (an older build, a hand edit, a server answer
 * without the id) is not known.
 *
 * Starts the real device process against the local stand-in
 * (helpers/remote-stand-in.js). Its device-code endpoint refuses and counts
 * each request: a request there is the device asking to log in.
 *
 * Runs as part of `npm test`, or standalone:
 *   node test/run-all-tests.js test/test-remote-device-session-without-id.js
 */
import assert from 'node:assert';
import { startDevice, stopHard, tail, waitFor, writeDeviceConfig } from './helpers/remote-device.js';
import { startRemoteStandIn } from './helpers/remote-stand-in.js';
import { createTestEnv } from './helpers/test-env.js';
import { runIfMain } from './helpers/run-if-main.js';

/** A start that fails does so within seconds; this is far above */
const EXIT_DEADLINE_MS = 60_000;

async function runTests() {
  const failures = [];

  async function test(name, fn) {
    const standIn = await startRemoteStandIn();
    const testEnv = createTestEnv();
    const devices = [];
    const start = () => {
      const device = startDevice({ ...testEnv.env, MCP_SERVER_URL: standIn.url });
      devices.push(device);
      return device;
    };
    try {
      await fn({ standIn, home: testEnv.home, start });
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

  await test('a saved session without a device id sends the device to log in again', async ({ standIn, home, start }) => {
    writeDeviceConfig(home, { session: standIn.login() });

    const device = start();
    // Either way this start ends: the stand-in refuses the device-code flow too
    await waitFor(device, () => false, EXIT_DEADLINE_MS);

    assert.ok(!/Device not found: undefined/.test(device.output) && standIn.deviceFlowRequests > 0,
      'with a saved session but no device id, the device failed with "Device not found: undefined" '
      + `(exit ${device.code}) instead of asking to log in again; every restart repeats it. `
      + `Device-code flow requests: ${standIn.deviceFlowRequests}. Its output:\n${tail(device.output)}`);
  });

  console.log(`\n${failures.length ? '🔴' : '✅'} remote device session without id: ${failures.length} failing test(s).`);
  return failures.length === 0;
}

runIfMain(import.meta.url, runTests);
