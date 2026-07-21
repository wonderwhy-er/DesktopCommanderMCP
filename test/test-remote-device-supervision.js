/**
 * Supervision tests for the remote-device local-child recovery path (PR #598 follow-ups).
 *
 * Five cases, each pinning a reviewed defect. All five are EXPECTED TO FAIL on
 * the unfixed PR #598 head — run red first, then implement:
 *
 *   1. in-flight fail-fast — a callClientTool in flight when the child dies must
 *      reject promptly ("Connection closed"), not hang until the SDK's 60s
 *      request timeout. Broken by assigning transport.onclose/onerror AFTER
 *      client.connect() (the SDK only chains handlers that exist BEFORE).
 *   2. restart backoff — repeated child deaths must space restart attempts out
 *      (exponential backoff), not respawn at a constant ~0.3s cadence that
 *      hammers mcp_devices with offline/online PATCH pairs.
 *   3. retry until recovered — a restart attempt that fails transiently must be
 *      retried, not abandoned forever (device otherwise stays offline until a
 *      human restarts the process).
 *   4. null-guard — child death in the window between ensureReady() resolving
 *      and callTool() must surface a descriptive Error, not a TypeError on a
 *      null client.
 *   5. status arbiter — device status must be the AND of channel-ready and
 *      child-ready with transition-only writes; a channel resubscribe while the
 *      child is dead must NOT write 'online' (remote-channel.ts currently
 *      writes 'online' on every SUBSCRIBED, contradicting child supervision).
 *
 * Runs under `npm test` (imports compiled dist) or standalone:
 *   node test/test-remote-device-supervision.js
 */
import assert from 'node:assert';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
// Consumed by the (to-be-implemented) backoff so tests run the ladder fast.
// Base must dominate the ~300ms child respawn overhead or ratios get noisy.
process.env.DC_LOCAL_RESTART_BACKOFF_BASE_MS = '400';
process.env.DC_LOCAL_RESTART_STABLE_UPTIME_MS = '5000';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const waitUntil = async (cond, ms) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) return false;
    await sleep(25);
  }
  return true;
};

/** Fresh MCPDevice with a stubbed network layer; records every status PATCH. */
async function makeDevice() {
  const { MCPDevice } = await import('../dist/remote-device/device.js');
  const device = new MCPDevice();
  const patches = [];
  device.remoteChannel = {
    setOnlineStatus: async (_id, status) => { patches.push({ t: Date.now(), status }); },
  };
  device.deviceId = 'test-device';
  await device.desktop.initialize();
  // Wire exactly as MCPDevice.initialize() does (arbiter only exists post-fix).
  device.desktop.onDisconnect((reason) => void device.handleLocalMcpLoss(reason));
  device.statusArbiter?.report('child', true);
  // Arbiter writes are queued on an async chain — let the setup write land
  // before taking the baseline; cases measure from here.
  await sleep(50);
  patches.splice(0);
  return { device, patches };
}

async function quietShutdown(target) {
  try { await target.shutdown(); } catch { /* teardown best-effort */ }
}

// 1 ────────────────────────────────────────────────────────────────────────────
async function testInflightCallFailsFast() {
  const { DesktopCommanderIntegration } = await import('../dist/remote-device/desktop-commander-integration.js');
  const integ = new DesktopCommanderIntegration();
  await integ.initialize();
  const childPid = integ.mcpTransport.pid;

  const t0 = Date.now();
  const inflight = integ
    .callClientTool('start_process', { command: 'sleep 120', timeout_ms: 110000 })
    .then(() => ({ rejected: false }), (e) => ({ rejected: true, message: e.message }));

  await sleep(1000);
  process.kill(childPid, 'SIGKILL');

  // Guard well past the SDK's 60s request timeout so a hang still terminates.
  const result = await Promise.race([inflight, sleep(75000).then(() => null)]);
  const elapsed = Date.now() - t0;
  await quietShutdown(integ);

  assert.ok(result && result.rejected, 'in-flight call must reject when the child dies');
  assert.ok(elapsed < 10000,
    `in-flight call must fail fast on child death; took ${(elapsed / 1000).toFixed(1)}s (${result.message}) — ` +
    `60s means the SDK's close handler was clobbered by a post-connect onclose assignment`);
  console.log(`✓ in-flight call failed fast (${(elapsed / 1000).toFixed(1)}s: ${result.message})`);
}

// 2 ────────────────────────────────────────────────────────────────────────────
async function testRestartBackoffEscalates() {
  const { device, patches } = await makeDevice();
  const CYCLES = 4;

  for (let i = 0; i < CYCLES; i++) {
    const onlinesBefore = patches.filter(p => p.status === 'online').length;
    process.kill(device.desktop.mcpTransport.pid, 'SIGKILL');
    const recovered = await waitUntil(
      () => patches.filter(p => p.status === 'online').length > onlinesBefore, 20000);
    assert.ok(recovered, `device must recover after kill #${i + 1}`);
  }
  await quietShutdown(device);

  const onlineTimes = patches.filter(p => p.status === 'online').map(p => p.t);
  const gaps = onlineTimes.slice(1).map((t, i) => t - onlineTimes[i]);
  assert.strictEqual(patches.length, CYCLES * 2,
    `expected exactly ${CYCLES * 2} status writes (one offline/online pair per cycle), got ${patches.length}`);
  for (let i = 1; i < gaps.length; i++) {
    assert.ok(gaps[i] >= gaps[i - 1] * 1.4,
      `restart cadence must back off for deaths in quick succession; ` +
      `recovery gaps were ${gaps.map(g => g + 'ms').join(', ')} (constant cadence = mcp_devices PATCH storm)`);
  }
  console.log(`✓ restart backoff escalates (recovery gaps: ${gaps.map(g => g + 'ms').join(', ')})`);
}

// 3 ────────────────────────────────────────────────────────────────────────────
async function testRestartRetriesTransientFailure() {
  const { device, patches } = await makeDevice();

  // First two restart attempts fail (e.g. files mid-upgrade), third succeeds.
  const realInit = device.desktop.initialize.bind(device.desktop);
  let attempts = 0;
  device.desktop.initialize = async () => {
    if (attempts++ < 2) throw new Error('simulated transient restart failure');
    return realInit();
  };

  process.kill(device.desktop.mcpTransport.pid, 'SIGKILL');
  const recovered = await waitUntil(() => patches.some(p => p.status === 'online'), 20000);
  await quietShutdown(device);

  assert.ok(recovered,
    'a transiently failing restart must be retried until it succeeds — ' +
    'giving up after one attempt leaves the device offline until a human restarts it');
  assert.ok(attempts >= 3, `expected ≥3 initialize attempts, saw ${attempts}`);
  console.log(`✓ restart retried through transient failures (${attempts} attempts)`);
}

// 4 ────────────────────────────────────────────────────────────────────────────
async function testCallClientToolNullGuard() {
  const { DesktopCommanderIntegration } = await import('../dist/remote-device/desktop-commander-integration.js');
  const integ = new DesktopCommanderIntegration();
  await integ.initialize();

  // Compress the race: the child dies right after the readiness check.
  const realEnsure = integ.ensureReady.bind(integ);
  integ.ensureReady = async () => { await realEnsure(); integ.mcpClient = null; };

  let error = null;
  try { await integ.callClientTool('get_config', {}); } catch (e) { error = e; }
  await quietShutdown(integ);

  assert.ok(error, 'callClientTool must throw when the client is lost mid-call');
  assert.ok(!(error instanceof TypeError),
    `lost client must surface a descriptive Error, not ${error.constructor.name}: ${error.message}`);
  console.log(`✓ null client surfaces a descriptive error (${error.message})`);
}

// 5 ────────────────────────────────────────────────────────────────────────────
async function testStatusArbiterGatesOnBothHealthSignals() {
  // Intended module for the single-writer status arbiter (does not exist yet on
  // the unfixed build — dynamic import so this fails as a case, not at load).
  const { DeviceStatusArbiter } = await import('../dist/remote-device/device-status-arbiter.js');

  const writes = [];
  const arbiter = new DeviceStatusArbiter({
    write: async (status) => { writes.push(status); },
  });

  arbiter.report('channel', true);
  arbiter.report('child', true);
  await sleep(50);
  assert.deepStrictEqual(writes, ['online'], 'both healthy → exactly one online write');

  arbiter.report('child', false);          // child died
  await sleep(50);
  assert.deepStrictEqual(writes, ['online', 'offline'], 'child death → offline');

  arbiter.report('channel', true);         // channel resubscribed while child dead
  arbiter.report('channel', true);
  await sleep(50);
  assert.deepStrictEqual(writes, ['online', 'offline'],
    'channel SUBSCRIBED while the child is dead must NOT write online (and repeats must not re-write)');

  arbiter.report('child', true);           // child recovered
  await sleep(50);
  assert.deepStrictEqual(writes, ['online', 'offline', 'online'], 'recovery → single online write');
  console.log('✓ status arbiter gates on channel AND child, transition-only writes');
}

// ──────────────────────────────────────────────────────────────────────────────
const CASES = [
  ['in-flight call fails fast on child death', testInflightCallFailsFast],
  ['restart backoff escalates', testRestartBackoffEscalates],
  ['restart retries transient failure', testRestartRetriesTransientFailure],
  ['callClientTool null-guard', testCallClientToolNullGuard],
  ['status arbiter gates online on both signals', testStatusArbiterGatesOnBothHealthSignals],
];

async function main() {
  console.log('=== remote-device supervision ===\n');
  const filter = process.argv[2];
  const cases = filter ? CASES.filter(([name]) => name.includes(filter)) : CASES;
  const failures = [];
  for (const [name, fn] of cases) {
    try {
      await fn();
    } catch (err) {
      failures.push([name, err.message]);
      console.error(`✗ ${name}\n  ${err.message}`);
    }
  }
  console.log(`\n${cases.length - failures.length}/${cases.length} passed`);
  if (failures.length) process.exit(1);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('✗ FATAL:', err.message);
  process.exit(1);
});
