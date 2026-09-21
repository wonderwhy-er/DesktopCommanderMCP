#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { BroadcastAnalytics, captureArrival, MAX_BUFFERED_OBSERVATIONS, MAX_OBSERVED_CALLS, OBSERVATION_WINDOW_MS } from '../dist/remote-device/broadcast-analytics.js';
import { RemoteChannel } from '../dist/remote-device/remote-channel.js';
import { MCPDevice } from '../dist/remote-device/device.js';
import { DesktopCommanderIntegration } from '../dist/remote-device/desktop-commander-integration.js';
import { configManager } from '../dist/config-manager.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
let passed = 0;
const pause = () => new Promise((resolve) => setImmediate(resolve));
async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
function fixture({ claimErrors = 0, ambiguous = false, fallbackError = false, resultErrors = 0, resultThrows = false, executorError = false, executorResultError = false, readyError = false } = {}) {
  const events = [], operations = [], waits = [];
  const row = { id: 'call-1', user_id: 'account-1', device_id: 'device-1', status: 'pending',
    tool_name: 'example', tool_args: { private: 'NEVER_ANALYTICS' }, metadata: {}, timeout_at: '2000-01-01T00:00:00Z' };
  let claimCount = 0, writeCount = 0, executed = 0;
  const rc = new RemoteChannel();
  rc.deviceId = row.device_id; rc._user = { id: row.user_id };
  rc.broadcastAnalytics = new BroadcastAnalytics(async (batch) => { events.push(...batch); });
  rc.sleep = async (ms) => { waits.push(ms); await pause(); };
  rc.client = { from(table) {
    assert.equal(table, 'mcp_remote_calls');
    let update, selected; const filters = {};
    const query = {
      update(value) { update = value; return query; },
      select(value) { selected = value; return query; },
      eq(key, value) { filters[key] = value; return query; },
      maybeSingle() { return query; },
      then(resolve, reject) { return Promise.resolve().then(() => {
        operations.push({ update, selected, filters: { ...filters } });
        if (update?.status === 'executing') {
          claimCount++;
          if (ambiguous && claimCount === 1) row.status = 'executing';
          if (claimCount <= claimErrors || (fallbackError && selected === 'id')) return { data: null, error: { message: 'private provider error' } };
          if (row.status !== 'pending') return { data: [], error: null };
          row.status = 'executing';
          return { data: [{ ...row }], error: null };
        }
        if (update) {
          writeCount++;
          if (resultThrows && writeCount === 1) throw new Error('private thrown write');
          if (writeCount <= resultErrors) return { error: { message: 'private result error' } };
          Object.assign(row, update); return { error: null };
        }
        return { data: { ...row }, error: null };
      }).then(resolve, reject); },
    };
    return query;
  } };
  const desktop = new DesktopCommanderIntegration();
  desktop.ensureReady = async () => { await pause(); if (readyError) throw new Error('private readiness'); };
  desktop.mcpClient = { callTool: async () => { executed++; await pause(); if (executorError) throw new Error('private tool failure'); return { content: [], ...(executorResultError ? { isError: true } : {}) }; } };
  const device = Object.create(MCPDevice.prototype);
  Object.assign(device, { deviceId: row.device_id, remoteChannel: rc, desktop, seenCallIds: new Set() });
  let done = Promise.resolve();
  rc.onToolCall = (payload) => (done = device.handleNewToolCall(payload));
  return { rc, device, row, events, operations, waits, get executed() { return executed; },
    async deliver(payload = { call_id: row.id, device_id: row.device_id }) { await rc.onDoorbell(payload); await done; await rc.broadcastAnalytics.flush(); },
    stop() { rc.broadcastAnalytics.stop(); } };
}

await check('targeted callback retains one atomic claim, executor readiness and result write; expiry behavior unchanged', async () => {
  const s = fixture();
  try {
    await s.deliver({ call_id: s.row.id, device_id: 'other-device' });
    assert.equal(s.operations.length, 0); assert.equal(s.events.length, 0);
    await s.deliver();
    assert.equal(s.executed, 1); assert.equal(s.row.status, 'completed');
    assert.equal(s.operations.length, 2, 'one UPDATE RETURNING claim, one result write');
    assert.deepEqual(s.operations[0], { update: { status: 'executing' }, selected: '*', filters: { id: 'call-1', device_id: 'device-1', status: 'pending' } });
    const ends = s.events.filter((e) => e.stage === 'operation_end');
    assert.deepEqual(ends.map((e) => e.operation), ['claim_fetch', 'executor_ready', 'executor', 'result_write']);
    assert.ok(ends.every((e) => e.duration_ms >= 0 && e.outcome === 'success'));
    for (const end of ends) {
      const start = s.events.find((e) => e.stage === 'operation_start' && e.operation_id === end.operation_id);
      assert.equal(end.duration_ms, end.monotonic_ms - start.monotonic_ms);
    }
    const ready = ends.find((e) => e.operation === 'executor_ready');
    assert.ok(s.events.find((e) => e.stage === 'execution_start').monotonic_ms >= ready.monotonic_ms);
    assert.ok(s.events.every((e) => e.call_id === 'call-1' && e.transport === 'broadcast' && e.attempt_number === 1));
    assert.ok(!JSON.stringify(s.events).includes('NEVER_ANALYTICS'));
    await s.deliver();
    assert.equal(s.executed, 1);
    assert.equal(s.events.filter((e) => e.stage === 'received').at(-1).duplicate_count, 1);
    assert.equal(s.events.filter((e) => e.stage === 'execution_start').length, 1);
  } finally { s.stop(); }
});

await check('callback capture precedes handler work and wrong-target fan-out creates no per-call telemetry', async () => {
  const s = fixture(); let callback;
  const channel = { on(_type, _filter, fn) { callback = fn; return channel; }, subscribe() { return channel; } };
  s.rc.client.channel = () => channel;
  void s.rc.createChannel();
  try {
    let captured;
    s.rc.onDoorbell = async (_payload, arrival) => { captured = arrival; await pause(); };
    const before = performance.now(); callback({ payload: { call_id: 'call-1', device_id: 'device-1' } });
    assert.ok(captured.monotonic_ms >= before && captured.monotonic_ms <= performance.now());
    assert.ok(Number.isFinite(Date.parse(captured.timestamp_utc)));
  } finally { s.stop(); }
});

await check('existing claim retry and fallback requests are unchanged, including fail-open fallback claim', async () => {
  const s = fixture({ claimErrors: 3, fallbackError: true });
  try {
    await s.deliver();
    assert.deepEqual(s.waits, [500, 1500]);
    assert.equal(s.operations.length, 6, '3 claims, fallback read, fallback claim, result write');
    assert.equal(s.executed, 1, 'preserve main fallback claim fail-open behavior');
    const claims = s.events.filter((e) => e.stage === 'operation_end' && e.operation === 'claim_fetch');
    assert.deepEqual(claims.map((e) => e.operation_attempt), [1, 2, 3]);
    assert.ok(claims.slice(1).every((e) => e.retry_wait_ms >= 0));
    assert.ok(s.events.some((e) => e.operation === 'fallback_claim' && e.outcome === 'failed'));
    assert.ok(s.events.every((e) => e.attempt_number === 1), 'DB retries are not notification retries');
  } finally { s.stop(); }
});

await check('ambiguous committed claim remains unexecuted, with observed fallback and rejection', async () => {
  const s = fixture({ claimErrors: 1, ambiguous: true });
  try {
    await s.deliver();
    assert.equal(s.executed, 0); assert.equal(s.operations.length, 3);
    assert.deepEqual(s.waits, [500]);
    assert.ok(s.events.some((e) => e.reason === 'claim_unresolved'));
    assert.ok(!s.events.some((e) => e.stage === 'execution_start'));
  } finally { s.stop(); }
});

await check('readiness, executor and returned/thrown result failures retain existing behavior and separate operations', async () => {
  for (const fault of ['readyError', 'executorError', 'executorResultError', 'resultErrors', 'resultThrows']) {
    const s = fixture({ [fault]: fault === 'resultErrors' ? 1 : true });
    try {
      await s.deliver();
      assert.equal(s.row.status, fault === 'executorResultError' ? 'completed' : 'failed');
      assert.equal(s.executed, fault === 'readyError' ? 0 : 1);
      assert.equal(s.events.filter((e) => e.stage === 'execution_start').length, fault === 'readyError' ? 0 : 1);
      assert.ok(s.events.some((e) => e.stage === 'operation_end' && e.outcome === 'failed'));
      if (fault.startsWith('result')) {
        assert.deepEqual(s.events.filter((e) => e.stage === 'operation_end' && e.operation === 'result_write').map((e) => e.operation_attempt), [1, 2]);
      }
      assert.ok(!JSON.stringify(s.events).includes('private'));
    } finally { s.stop(); }
  }
});

await check('telemetry failure, malformed correlation and direct legacy calls do not change execution', async () => {
  const s = fixture();
  try {
    s.rc.broadcastAnalytics.receipt = () => { throw new Error('observation failure'); };
    await s.deliver(); assert.equal(s.executed, 1); assert.equal(s.operations.length, 2);
    const direct = fixture();
    try { await direct.device.handleNewToolCall({ new: direct.row }); assert.equal(direct.executed, 1); assert.equal(direct.events.length, 0); }
    finally { direct.stop(); }
  } finally { s.stop(); }
  const malformed = fixture();
  try { malformed.row.id = { unsafe: true }; await malformed.deliver(); assert.equal(malformed.events.length, 0); assert.equal(malformed.rc.broadcastAnalytics.counters.malformed, 1); }
  finally { malformed.stop(); }
});

await check('bounded queues/state, stable retries, drop reporting, expiry and identity-reset cancellation', async () => {
  const batches = []; let fail = true;
  const analytics = new BroadcastAnalytics(async (batch) => { batches.push(batch.map((e) => e.observation_id)); if (fail) throw new Error('outage'); });
  try {
    for (let i = 0; i < MAX_BUFFERED_OBSERVATIONS + 10; i++) analytics.receipt(`call-${i}`, { monotonic_ms: i, timestamp_utc: '2026-01-01T00:00:00Z' });
    assert.equal(analytics.counters.queued, MAX_BUFFERED_OBSERVATIONS);
    assert.equal(analytics.counters.tracked, MAX_OBSERVED_CALLS);
    assert.equal(analytics.counters.dropped, 10);
    await analytics.flush(); await analytics.flush(); await analytics.flush();
    assert.deepEqual(batches[0], batches[1]); assert.deepEqual(batches[1], batches[2]);
    assert.equal(analytics.counters.dropped, 60);
    fail = false;
    const context = analytics.receipt('recovered', { monotonic_ms: OBSERVATION_WINDOW_MS + 2000, timestamp_utc: '2020-01-01T00:00:00Z' });
    assert.equal(analytics.queue.at(-1).dropped_count, 60);
    assert.equal(analytics.counters.tracked, 1);
    const end = context.operation('executor');
    analytics.reset(); end('success');
    assert.equal(analytics.counters.queued, 0);
    const other = execFileSync(process.execPath, ['--input-type=module', '-e', "import {BroadcastAnalytics,captureArrival} from './dist/remote-device/broadcast-analytics.js';const a=new BroadcastAnalytics(async e=>console.log(e[0].source_process_id));a.receipt('call',captureArrival());await a.flush();a.stop();"], { encoding: 'utf8', cwd: new URL('../', import.meta.url) }).trim();
    analytics.receipt('new', captureArrival());
    assert.notEqual(analytics.queue[0].source_process_id, other);
  } finally { analytics.stop(); }
  let release, aborted = false;
  const reset = new BroadcastAnalytics(async (_batch, signal) => { signal.addEventListener('abort', () => { aborted = true; }); await new Promise((resolve) => { release = resolve; }); });
  reset.receipt('old', captureArrival()); const sending = reset.flush(); reset.reset();
  reset.receipt('new', captureArrival()); release(); await sending;
  assert.ok(aborted); assert.equal(reset.queue[0].call_id, 'new'); reset.stop();
});

await check('session replacement invalidates late observations without gating existing execution', async () => {
  const s = fixture();
  let finishSession;
  s.rc.client.auth = {
    setSession: async () => { await new Promise((resolve) => { finishSession = resolve; }); return { data: { user: { id: 'new-account' } }, error: null }; },
    getSession: async () => ({ data: { session: { access_token: 'new-token' } } }),
    onAuthStateChange: () => {},
  };
  s.rc.client.realtime = { setAuth: () => {} };
  try {
    const old = s.rc.broadcastAnalytics.receipt('old', captureArrival());
    const session = s.rc.setSession({ access_token: 'new-token', refresh_token: null });
    await pause();
    await s.deliver();
    assert.equal(s.executed, 1, 'telemetry transition must not add execution admission');
    assert.equal(s.events.length, 0, 'no stale identity attributed while authentication changes');
    finishSession(); await session; old.stage('execution_finish');
    assert.equal(s.rc.broadcastAnalytics.counters.queued, 0);
  } finally { s.stop(); }
});

await check('authenticated relay uses selected secure backend, opt-outs, bounded acknowledgement and local allowlist', async () => {
  const originalGet = configManager.getValue;
  let enabled = true, requests = 0, body, validAck = true, holdResponse = false, acceptedRequest;
  configManager.getValue = async () => enabled;
  const server = createServer(async (request, response) => {
    requests++; assert.equal(request.url, '/device/transport-observations');
    assert.equal(request.headers.authorization, 'Bearer local-test-token');
    let data = ''; for await (const chunk of request) data += chunk;
    body = JSON.parse(data);
    if (holdResponse) { acceptedRequest(); return; }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ accepted: body.observations.length, dropped: validAck ? 0 : 1 }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const make = (url) => { const rc = new RemoteChannel(url); rc.deviceId = 'device-1'; rc._user = { id: 'account-1' }; rc.lastKnownSession = { access_token: 'local-test-token' }; rc.broadcastAnalytics.receipt('call-1', captureArrival()); return rc; };
  delete process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY;
  process.env.BROADCAST_ANALYTICS_ALLOW_INSECURE_LOCAL = 'true';
  const channels = [];
  try {
    let rc = make(base); channels.push(rc); await rc.broadcastAnalytics.flush();
    assert.equal(requests, 1); assert.equal(body.device_id, 'device-1');
    assert.equal(body.observations[0].transport, 'broadcast');
    enabled = false; rc.broadcastAnalytics.receipt('optout', captureArrival()); await rc.broadcastAnalytics.flush(); assert.equal(requests, 1);
    enabled = true; validAck = false; rc.broadcastAnalytics.receipt('bad-ack', captureArrival()); await rc.broadcastAnalytics.flush(); assert.equal(rc.broadcastAnalytics.counters.queued, 1);
    for (const url of ['http://example.com', 'http://127.0.0.1.evil.invalid', 'https://user:secret@example.com']) {
      rc = make(url); channels.push(rc); await rc.broadcastAnalytics.flush(); assert.equal(rc.broadcastAnalytics.counters.queued, 1);
    }
    holdResponse = true;
    rc = make(base); channels.push(rc);
    const reached = new Promise((resolve) => { acceptedRequest = resolve; });
    const sending = rc.broadcastAnalytics.flush(); await reached;
    const cancelledAt = performance.now(); rc.broadcastAnalytics.reset(); await sending;
    assert.ok(performance.now() - cancelledAt < 1000, 'identity reset aborts the actual in-flight HTTP request');
    assert.equal(rc.broadcastAnalytics.counters.queued, 0);
    holdResponse = false;
    delete process.env.BROADCAST_ANALYTICS_ALLOW_INSECURE_LOCAL;
    rc = make(base); channels.push(rc); const before = requests; await rc.broadcastAnalytics.flush(); assert.equal(requests, before);
    process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
    rc = make(base); channels.push(rc); assert.equal(rc.broadcastAnalytics.counters.queued, 0);
  } finally {
    channels.forEach((rc) => rc.broadcastAnalytics.stop()); configManager.getValue = originalGet;
    process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1'; delete process.env.BROADCAST_ANALYTICS_ALLOW_INSECURE_LOCAL;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
console.log(`PASS Broadcast analytics: ${passed} checks`);
