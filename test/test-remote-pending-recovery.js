#!/usr/bin/env node

/**
 * Regression tests for missed new_call recovery.
 *
 * Realtime Broadcast is a wake-up signal, not a durable queue. If a device
 * reconnects after missing a doorbell, it must discover still-live pending rows
 * for itself and route them through the same atomic claim path as a doorbell.
 */

import assert from 'node:assert';
import { RemoteChannel } from '../dist/remote-device/remote-channel.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

const DEVICE_ID = 'device-1';
const OTHER_DEVICE_ID = 'device-2';

function makeClient(rows) {
  const calls = [];

  function matches(row, filters, gtFilters) {
    for (const [key, value] of Object.entries(filters)) {
      if (row[key] !== value) return false;
    }
    for (const [key, value] of Object.entries(gtFilters)) {
      if (!(row[key] > value)) return false;
    }
    return true;
  }

  function from(table) {
    assert.equal(table, 'mcp_remote_calls');
    let mode = 'select';
    let selectColumns = '*';
    let updatePayload = null;
    const filters = {};
    const gtFilters = {};
    let limitValue = null;

    const execute = async () => {
      calls.push({
        mode,
        selectColumns,
        updatePayload,
        filters: { ...filters },
        gtFilters: { ...gtFilters },
        limit: limitValue,
      });

      if (mode === 'update') {
        const row = rows.find((candidate) => matches(candidate, filters, gtFilters));
        if (!row) return { data: [], error: null };
        Object.assign(row, updatePayload);
        return {
          data: selectColumns === 'id' ? [{ id: row.id }] : [{ ...row }],
          error: null,
        };
      }

      let data = rows.filter((row) => matches(row, filters, gtFilters));
      data = data.sort((a, b) => a.created_at.localeCompare(b.created_at));
      if (limitValue !== null) data = data.slice(0, limitValue);
      if (selectColumns === 'id,device_id') {
        data = data.map(({ id, device_id }) => ({ id, device_id }));
      } else {
        data = data.map((row) => ({ ...row }));
      }
      return { data, error: null };
    };

    const builder = {
      select(columns = '*') {
        selectColumns = columns;
        return builder;
      },
      update(payload) {
        mode = 'update';
        updatePayload = payload;
        return builder;
      },
      eq(key, value) {
        filters[key] = value;
        return builder;
      },
      gt(key, value) {
        gtFilters[key] = value;
        return builder;
      },
      order() {
        return builder;
      },
      limit(value) {
        limitValue = value;
        return builder;
      },
      then(resolve, reject) {
        return execute().then(resolve, reject);
      },
    };
    return builder;
  }

  return { from, calls };
}

function makeRemoteChannel(rows) {
  const rc = new RemoteChannel();
  const client = makeClient(rows);
  const delivered = [];

  rc.client = client;
  rc._user = { id: 'user-1', email: 'tester@example.com' };
  rc.deviceId = DEVICE_ID;
  rc.deviceName = 'test-device';
  rc.channel = { state: 'joined' };
  rc.presenceTracked = true;
  rc.localExecutorProbe = () => true;
  rc.onToolCall = (payload) => delivered.push(payload);

  return { rc, client, delivered };
}

const now = Date.now();
const iso = (offsetMs) => new Date(now + offsetMs).toISOString();
const baseRow = (id, overrides = {}) => ({
  id,
  user_id: 'user-1',
  device_id: DEVICE_ID,
  status: 'pending',
  tool_name: 'ping',
  tool_args: {},
  metadata: {},
  created_at: iso(-5_000),
  timeout_at: iso(60_000),
  ...overrides,
});

{
  const rows = [
    baseRow('live-old', { created_at: iso(-10_000) }),
    baseRow('live-new', { created_at: iso(-1_000) }),
    baseRow('expired', { timeout_at: iso(-1_000) }),
    baseRow('other-device', { device_id: OTHER_DEVICE_ID }),
    baseRow('completed', { status: 'completed' }),
  ];
  const { rc, delivered } = makeRemoteChannel(rows);

  await rc.recoverPendingCalls();

  assert.deepEqual(
    delivered.map((payload) => payload.new.id),
    ['live-old', 'live-new'],
    'only live pending calls for this device should be recovered in creation order',
  );
  assert(delivered.every((payload) => payload.claimed === true), 'recovered rows must be atomically claimed before dispatch');
  assert.equal(rows.find((row) => row.id === 'expired').status, 'pending', 'expired call must not be claimed');
  assert.equal(rows.find((row) => row.id === 'other-device').status, 'pending', 'another device call must not be claimed');
}

{
  const rows = [baseRow('expires-before-claim', { timeout_at: iso(-1) })];
  const { rc, delivered } = makeRemoteChannel(rows);

  await rc.onDoorbell({ call_id: 'expires-before-claim', device_id: DEVICE_ID });

  assert.equal(delivered.length, 0, 'the atomic claim must reject an already-expired call');
  assert.equal(rows[0].status, 'pending');
}

{
  const rc = new RemoteChannel();
  let recoveryCalls = 0;

  rc.client = {};
  rc.deviceId = DEVICE_ID;
  rc.deviceName = 'test-device';
  rc.channel = { state: 'joined', track: async () => 'ok' };
  rc.localExecutorProbe = () => true;
  rc.setTransportCapable = async () => true;
  rc.queueStatusWrite = async () => true;
  rc.recoverPendingCalls = async () => { recoveryCalls++; };

  await rc.trackPresenceInner(2, 1);

  assert.equal(recoveryCalls, 1, 'successful presence/reconnect must trigger one pending-call recovery scan');
}

console.log('✅ Remote pending-call recovery tests passed');
