#!/usr/bin/env node

/**
 * Covers the branch's headline mechanism, which previously had no tests:
 *
 *   1. EXACTLY-ONCE under dual delivery. During the transition every call is
 *      delivered twice (legacy postgres_changes + broadcast doorbell). The DB
 *      claim deliberately fails OPEN on a transient write error, so the local
 *      seen-call-id guard in handleNewToolCall is what actually guarantees a
 *      side-effecting tool runs once.
 *   2. onDoorbell routing: ignore other devices, skip already-claimed rows,
 *      surface a missing row, and retry a transient fetch failure.
 *   3. updateCallResult BEFORE notifyResult — the server fetches the row by id
 *      when the doorbell arrives, so the write must land first or it sees a
 *      non-terminal row and waits for the 10s recovery poll.
 *
 * Run: npm run build && node test/test-remote-dedupe-and-doorbell.js
 */

import { MCPDevice } from '../dist/remote-device/device.js';
import { RemoteChannel } from '../dist/remote-device/remote-channel.js';

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✅ PASS  ${name}`);
  } catch (error) {
    failures++;
    console.error(`🔴 FAIL  ${name}\n     ${error.message}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const DEVICE_ID = 'device-1';
const OTHER_DEVICE = 'device-2';

/** MCPDevice with the network/desktop edges stubbed out. */
function makeDevice({ claimResults = [] } = {}) {
  const device = new MCPDevice();
  const executed = [];
  const claims = [...claimResults];

  device.deviceId = DEVICE_ID;
  device.desktop = {
    callClientTool: async (toolName, args) => {
      executed.push({ toolName, args });
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };
  device.remoteChannel = {
    // Default: first delivery claims, later ones lose. Overridable to model a
    // transient DB error, which makes the claim fail OPEN (returns true).
    markCallExecuting: async () => (claims.length ? claims.shift() : true),
    updateCallResult: async () => {},
    notifyResult: async () => {},
  };
  return { device, executed };
}

const payloadFor = (id, deviceId = DEVICE_ID) => ({
  new: { id, tool_name: 'start_process', tool_args: { command: 'echo hi' }, device_id: deviceId, metadata: {} },
});

await test('dual delivery of the same call executes the tool exactly once', async () => {
  const { device, executed } = makeDevice();
  await device.handleNewToolCall(payloadFor('call-a'));
  await device.handleNewToolCall(payloadFor('call-a')); // the other transport
  assert(executed.length === 1, `expected 1 execution, got ${executed.length}`);
});

await test('exactly-once holds even when the DB claim fails OPEN for both deliveries', async () => {
  // Both claims return true (what a transient REST error produces) — only the
  // in-memory guard prevents a second run of a side-effecting command.
  const { device, executed } = makeDevice({ claimResults: [true, true] });
  await device.handleNewToolCall(payloadFor('call-b'));
  await device.handleNewToolCall(payloadFor('call-b'));
  assert(executed.length === 1, `fail-open claim double-executed: ${executed.length} runs`);
});

await test('a lost DB claim (another process won) skips execution', async () => {
  const { device, executed } = makeDevice({ claimResults: [false] });
  await device.handleNewToolCall(payloadFor('call-c'));
  assert(executed.length === 0, `expected no execution, got ${executed.length}`);
});

await test('calls for a different device are ignored and do not poison the dedupe set', async () => {
  const { device, executed } = makeDevice();
  await device.handleNewToolCall(payloadFor('call-d', OTHER_DEVICE));
  assert(executed.length === 0, 'must not execute another device call');
  // Same id later arriving FOR US must still run — the filter precedes dedupe.
  await device.handleNewToolCall(payloadFor('call-d'));
  assert(executed.length === 1, 'a mismatched delivery must not suppress our own');
});

await test('the seen-call-id set stays bounded', async () => {
  const { device } = makeDevice();
  for (let i = 0; i < 250; i++) await device.handleNewToolCall(payloadFor(`bulk-${i}`));
  assert(device.seenCallIds.size <= 100, `set grew to ${device.seenCallIds.size}`);
});

// --- onDoorbell -------------------------------------------------------------

/** RemoteChannel with just enough of a Supabase client for onDoorbell. */
function makeChannel({ rows = {}, failFetches = 0 } = {}) {
  const rc = new RemoteChannel();
  const delivered = [];
  let fetchAttempts = 0;
  rc.deviceId = DEVICE_ID;
  rc.onToolCall = (payload) => delivered.push(payload);
  rc.sleep = () => Promise.resolve(); // no real backoff in tests
  rc.client = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            fetchAttempts++;
            if (fetchAttempts <= failFetches) return { data: null, error: { message: 'fetch failed' } };
            return { data: rows.row ?? null, error: null };
          },
        }),
      }),
    }),
  };
  return { rc, delivered, attempts: () => fetchAttempts };
}

await test('doorbell for another device is ignored without fetching', async () => {
  const { rc, delivered, attempts } = makeChannel();
  await rc.onDoorbell({ call_id: 'x', device_id: OTHER_DEVICE });
  assert(delivered.length === 0, 'must not deliver');
  assert(attempts() === 0, 'must not even fetch the row');
});

await test('doorbell delivers a pending row through the shared handler', async () => {
  const row = { id: 'x', status: 'pending', tool_name: 'start_process' };
  const { rc, delivered } = makeChannel({ rows: { row } });
  await rc.onDoorbell({ call_id: 'x', device_id: DEVICE_ID });
  assert(delivered.length === 1, 'expected one delivery');
  assert(delivered[0].new === row, 'must pass the fetched row as {new: row}');
});

await test('doorbell for an already-claimed row does not re-deliver', async () => {
  const { rc, delivered } = makeChannel({ rows: { row: { id: 'x', status: 'executing' } } });
  await rc.onDoorbell({ call_id: 'x', device_id: DEVICE_ID });
  assert(delivered.length === 0, 'non-pending rows must not be re-delivered');
});

await test('doorbell row fetch retries a transient failure', async () => {
  const row = { id: 'x', status: 'pending' };
  const { rc, delivered, attempts } = makeChannel({ rows: { row }, failFetches: 2 });
  await rc.onDoorbell({ call_id: 'x', device_id: DEVICE_ID });
  assert(attempts() === 3, `expected 3 attempts, got ${attempts()}`);
  assert(delivered.length === 1, 'should deliver after the retry succeeds');
});

await test('doorbell with a missing row is a no-op (already claimed and deleted)', async () => {
  const { rc, delivered } = makeChannel({ rows: { row: null } });
  await rc.onDoorbell({ call_id: 'gone', device_id: DEVICE_ID });
  assert(delivered.length === 0, 'missing row must not deliver');
});

// --- result ordering --------------------------------------------------------

await test('the result row is written BEFORE the doorbell is rung', async () => {
  const order = [];
  const { device, executed } = makeDevice();
  device.remoteChannel.updateCallResult = async () => { order.push('write'); };
  device.remoteChannel.notifyResult = async () => { order.push('doorbell'); };
  await device.handleNewToolCall(payloadFor('call-order'));
  assert(executed.length === 1, 'tool should have run');
  assert(
    order.join(',') === 'write,doorbell',
    `server fetches by id on the doorbell, so the write must land first: got ${order.join(',')}`
  );
});

console.log(`\n${failures ? '🔴' : '✅'} dedupe + doorbell: ${failures} failing test(s).`);
process.exit(failures ? 1 : 0);
