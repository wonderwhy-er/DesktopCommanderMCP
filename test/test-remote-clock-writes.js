#!/usr/bin/env node

/**
 * Device-written database timestamps must be evaluated by PostgreSQL, not
 * estimated from the device clock or from an observed Supabase Date header.
 *
 * mcp_devices.last_seen uses the PostgREST timestamp literal 'now', which
 * PostgreSQL casts to timestamptz when applying the PATCH. The DB terminal
 * status trigger independently stamps mcp_remote_calls.completed_at = now().
 * These assertions exercise every remote-channel write path with no network.
 *
 * Run: npm run build && node test/test-remote-clock-writes.js
 */

import assert from 'node:assert/strict';
import { RemoteChannel, observeServerDate } from '../dist/remote-device/remote-channel.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

const DEVICE_ID = 'device-1';
const realNow = Date.now.bind(Date);

function makeClient(writes) {
  function from(table) {
    let update = null;
    const builder = {
      select() { return builder; },
      eq() { return builder; },
      maybeSingle() { return builder; },
      abortSignal() { return builder; },
      update(values) { update = values; return builder; },
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

async function deviceWrites() {
  const rc = new RemoteChannel();
  const writes = [];
  rc.client = makeClient(writes);
  rc._user = { id: 'user-1', email: 'tester@example.com' };
  rc.channel = { state: 'joined' };
  rc.channelReady = true;
  rc.localExecutorProbe = () => true;
  rc.createChannel = async () => {};

  await rc.registerDevice({}, DEVICE_ID, 'test-device', () => {});
  await rc.updateHeartbeat();
  await rc.setOnlineStatus(DEVICE_ID, 'online');
  await rc.updateCallResult('call-1', 'completed', { content: [] });

  assert.deepEqual(writes.map(({ table }) => table),
    ['mcp_devices', 'mcp_devices', 'mcp_devices', 'mcp_remote_calls']);
  for (const { values } of writes.slice(0, 3)) {
    assert.equal(values.last_seen, 'now', 'database must stamp last_seen');
  }
  assert.equal(writes[3].values.status, 'completed');
  assert.equal(Object.hasOwn(writes[3].values, 'completed_at'), false,
    'terminal status trigger, not the device, must stamp completed_at');
}

// Also verify the first write works without ever observing a server Date header.
await deviceWrites();
console.log('✅ Database-time payloads work before the first Date header');

for (const skewMinutes of [-20, 2, 20]) {
  try {
    observeServerDate(new Date(realNow() + skewMinutes * 60_000).toUTCString());
    await deviceWrites();
    console.log(`✅ Database-time payloads independent of ${skewMinutes}m server/device skew`);
  } finally {
    // Keep Date.now monkey-patching isolated from other tests.
    observeServerDate(new Date(realNow()).toUTCString());
  }
}

console.log('✅ Remote database-owned timestamp tests passed');
