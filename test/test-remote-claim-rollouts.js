#!/usr/bin/env node

/**
 * Rollouts through the real claim code: the server writes the user's rollouts
 * into each call row (`metadata.rollouts`), the doorbell claim returns the whole
 * row, and the device keeps the map from the latest call it claimed.
 */

import assert from 'node:assert/strict';
import { RemoteChannel } from '../dist/remote-device/remote-channel.js';
import { rolloutManager } from '../dist/remote-device/rollouts.js';
import { runIfMain } from './helpers/run-if-main.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

const DEVICE_ID = 'device-1';

/** mcp_remote_calls as PostgREST answers the claim: pending -> executing returns the whole row. */
function makeClient(rows) {
  return {
    from(table) {
      assert.equal(table, 'mcp_remote_calls');
      const filters = {};
      let patch = null;
      const builder = {
        update(value) {
          patch = value;
          return builder;
        },
        eq(key, value) {
          filters[key] = value;
          return builder;
        },
        gt() {
          return builder;
        },
        select() {
          return builder;
        },
        then(resolve, reject) {
          const row = rows.find((candidate) => Object.entries(filters).every(([key, value]) => candidate[key] === value));
          if (row && patch) Object.assign(row, patch);
          return Promise.resolve({ data: row ? [{ ...row }] : [], error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

const callRow = (id, metadata) => ({
  id,
  user_id: 'user-1',
  device_id: DEVICE_ID,
  status: 'pending',
  tool_name: 'ping',
  tool_args: {},
  metadata,
  created_at: new Date().toISOString(),
  timeout_at: new Date(Date.now() + 60_000).toISOString(),
});

async function runTests() {
  const rows = [
    callRow('call-1', { transport: 'broadcast_v1', rollouts: { check: true } }),
    callRow('call-2', { transport: 'broadcast_v1', rollouts: { check: false } }),
    callRow('call-3', { transport: 'broadcast_v1' }),
    callRow('call-4', { transport: 'broadcast_v1' }),
  ];

  const rc = new RemoteChannel();
  const delivered = [];
  rc.client = makeClient(rows);
  rc._user = { id: 'user-1', email: 'tester@example.com' };
  rc.deviceId = DEVICE_ID;
  rc.deviceName = 'test-device';
  rc.channel = { state: 'joined' };
  rc.presenceTracked = true;
  rc.localExecutorProbe = () => true;
  rc.onToolCall = (payload) => delivered.push(payload);

  const rolloutLines = [];
  const consoleDebug = console.debug;
  console.debug = (...args) => {
    if (args[0] === 'Rollouts:') rolloutLines.push(args[1]);
    consoleDebug(...args);
  };

  try {
    await rc.onDoorbell({ call_id: 'call-1', device_id: DEVICE_ID });
    assert.equal(rolloutManager.get('check'), true, 'a claimed row with check: true turns check on');
    assert.deepEqual(rolloutLines, [{ check: true }], 'the debug line shows the change');

    await rc.onDoorbell({ call_id: 'call-2', device_id: DEVICE_ID });
    assert.equal(rolloutManager.get('check'), false, 'the next row with check: false turns it off');
    assert.deepEqual(rolloutLines, [{ check: true }, { check: false }], 'the debug line shows the change');

    await rc.onDoorbell({ call_id: 'call-3', device_id: DEVICE_ID });
    assert.deepEqual(rolloutManager.getAll(), {}, 'a row without the field (an older server) means all off');
    assert.deepEqual(rolloutLines, [{ check: true }, { check: false }, {}], 'the debug line shows the change');

    await rc.onDoorbell({ call_id: 'call-4', device_id: DEVICE_ID });
    assert.equal(rolloutLines.length, 3, 'no debug line when the rollouts stay the same');

    assert.deepEqual(delivered.map((payload) => payload.new.id), ['call-1', 'call-2', 'call-3', 'call-4'],
      'every claimed call still goes to device.ts');
  } finally {
    console.debug = consoleDebug;
  }

  console.log('✅ Remote claim rollouts tests passed');
}

runIfMain(import.meta.url, runTests);
