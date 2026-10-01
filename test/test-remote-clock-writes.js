#!/usr/bin/env node

/**
 * The times a device writes to its rows must be server time.
 *
 * The server compares two of them with its own clock:
 *   - mcp_devices.last_seen: a device is marked offline when it is older than
 *     15 min (checked every 60 s);
 *   - mcp_remote_calls.completed_at: finished calls whose completed_at is older
 *     than 1 min are deleted (every 30 s).
 *
 * The device wrote both with new Date(), its own clock. A device whose clock is
 * behind kept being marked offline while connected, and a result could be
 * deleted before the server read it. observeServerDate() corrects Date.now()
 * only, and only above 5 min; new Date() is never corrected.
 *
 * Here the server's Date header is 2 min and 20 min ahead of this machine (the
 * device is behind). Fake Supabase client; no network.
 *
 * Runs as part of `npm test`, or standalone:
 *   npm run build && node test/test-remote-clock-writes.js
 */

import assert from 'node:assert';
import { RemoteChannel, observeServerDate } from '../dist/remote-device/remote-channel.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

const DEVICE_ID = 'device-1';

/** The Date header has whole seconds; this leaves room for that and the writes themselves. */
const TOLERANCE_MS = 2000;

const realNow = Date.now.bind(Date); // captured before anything patches Date.now

/** A Supabase client that records every update and answers like the real one. */
function makeClient(writes) {
  function from(table) {
    let update = null;
    const builder = {
      select() { return builder; },
      eq() { return builder; },
      maybeSingle() { return builder; },
      update(values) {
        update = values;
        return builder;
      },
      then(resolve, reject) {
        if (update) writes.push({ table, values: update });
        const data = update ? [{ id: DEVICE_ID }] : { id: DEVICE_ID, device_name: 'test-device' };
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }
  return { from };
}

/** Registers a device, then sends a heartbeat, a status and a call result; returns the times written. */
async function deviceWrites() {
  const rc = new RemoteChannel();
  const writes = [];
  rc.client = makeClient(writes);
  rc._user = { id: 'user-1', email: 'tester@example.com' };
  rc.channel = { state: 'joined' };
  rc.presenceTracked = true;
  rc.localExecutorProbe = () => true;
  rc.createChannel = async () => {}; // the registration's row write only, no realtime

  await rc.registerDevice({}, DEVICE_ID, 'test-device', () => {});
  await rc.updateHeartbeat(DEVICE_ID);
  await rc.setOnlineStatus(DEVICE_ID, 'online');
  await rc.updateCallResult('call-1', 'completed', { content: [] });

  assert.deepEqual(writes.map(({ table }) => table),
    ['mcp_devices', 'mcp_devices', 'mcp_devices', 'mcp_remote_calls'], 'precondition: four row writes');
  return [
    ['the registration\'s last_seen', writes[0].values.last_seen],
    ['the heartbeat\'s last_seen', writes[1].values.last_seen],
    ['the status write\'s last_seen', writes[2].values.last_seen],
    ['the call result\'s completed_at', writes[3].values.completed_at],
  ];
}

/** Undo any correction a previous case left in place. */
function resetClock() {
  observeServerDate(new Date(realNow()).toUTCString());
}

let failures = 0;
async function test(name, fn) {
  try {
    resetClock();
    await fn();
    console.log(`✅ PASS  ${name}`);
  } catch (error) {
    failures++;
    console.error(`🔴 FAIL  ${name}\n     ${error.message}`);
  } finally {
    resetClock();
  }
}

for (const minutes of [2, 20]) {
  const serverAheadMs = minutes * 60_000;
  await test(`a device clock ${minutes} min behind the server writes server time`, async () => {
    observeServerDate(new Date(realNow() + serverAheadMs).toUTCString());
    const written = await deviceWrites();
    const serverTime = realNow() + serverAheadMs;

    const wrong = written
      .filter(([, value]) => !(Math.abs(Date.parse(value) - serverTime) <= TOLERANCE_MS))
      .map(([field, value]) => `${field} ${Math.round((serverTime - Date.parse(value)) / 1000)} s behind`);
    assert.equal(wrong.length, 0, `written on the device's clock, not the server's: ${wrong.join('; ')}`);
  });
}

console.log(`\n${failures ? '🔴' : '✅'} remote clock writes: ${failures} failing test(s).`);
process.exit(failures ? 1 : 0);
