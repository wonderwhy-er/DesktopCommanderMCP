/**
 * Test: Feature flags fetch must not block startup on slow networks
 *
 * Reproduces GitHub issue #465: ~30 second MCP startup delay caused by
 * feature flags fetch on high-latency networks where AbortController
 * doesn't interrupt in-progress TCP connect.
 *
 * Strategy: We spin up local TCP servers that simulate different slow-network
 * scenarios and point the real FeatureFlagManager (dist/utils/feature-flags.js)
 * at them via DC_FLAG_URL. Each scenario runs in a fresh process with a
 * temporary HOME, so the manager's flag cache never touches the real one.
 *
 * Product checks decide pass/fail. The AbortController diagnostics only report
 * how this platform's fetch behaves; the product must be safe either way.
 */

import { createServer } from 'net';
import http from 'http';
import assert from 'assert';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { runIfMain } from './helpers/run-if-main.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FLAGS_MODULE = pathToFileURL(path.join(__dirname, '..', 'dist', 'utils', 'feature-flags.js')).href;

// The product's fetch timeout (FETCH_TIMEOUT_MS in feature-flags.ts) plus margin
const FETCH_TIMEOUT_MS = 3000;
const MAX_FETCH_MS = FETCH_TIMEOUT_MS + 2000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a TCP server that accepts the connection but never sends any HTTP response */
function createBlackHoleServer() {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    // Hold the socket open forever — simulates a server that accepted TCP
    // but never responds at the HTTP level.
  });
  server._testSockets = sockets;
  return server;
}

/** Create a TCP server that deliberately delays the HTTP response */
function createSlowResponseServer(delayMs, flags = { slow: true }) {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: '1', flags }));
    }, delayMs);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server._testSockets = sockets;
  return server;
}

function listenOnRandomPort(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    // Destroy all lingering sockets first
    if (server._testSockets) {
      for (const socket of server._testSockets) {
        socket.destroy();
      }
    }
    server.close(() => resolve());
  });
}

const runTest = (name, testFn) => {
  return testFn()
    .then(() => {
      console.log(`✅ Test passed: ${name}`);
      return true;
    })
    .catch((error) => {
      console.error(`❌ Test failed: ${name}`);
      console.error(`   ${error.message}`);
      return false;
    });
};

// ---------------------------------------------------------------------------
// Run the real FeatureFlagManager in a fresh process
// ---------------------------------------------------------------------------

const CHILD_SCRIPT = `
if (process.env.STUB_HANGING_FETCH) {
  // A fetch that never settles and ignores its AbortSignal: the Windows + undici behavior from #465
  globalThis.fetch = () => new Promise(() => {});
}
const { featureFlagManager } = await import(process.env.FLAGS_MODULE);
const time = async (fn) => { const start = Date.now(); await fn(); return Date.now() - start; };
const result = {};
for (const step of process.env.STEPS.split(',')) {
  if (step === 'refresh') result.refreshMs = await time(() => featureFlagManager.refresh());
  if (step === 'initialize') result.initializeMs = await time(() => featureFlagManager.initialize());
  if (step === 'waitForFreshFlags') result.waitMs = await time(() => featureFlagManager.waitForFreshFlags());
}
result.flags = featureFlagManager.getAll();
console.log('RESULT ' + JSON.stringify(result));
process.exit(0);
`;

/**
 * Point FeatureFlagManager at `url`, run `steps` (refresh | initialize | waitForFreshFlags)
 * and return how long each took plus the flags it ended up with.
 */
async function runFlagManager(url, steps, { hangingFetch = false } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dc-flags-home-'));
  try {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD_SCRIPT], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        DC_FLAG_URL: url,
        FLAGS_MODULE,
        STEPS: steps.join(','),
        DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1',
        ...(hangingFetch ? { STUB_HANGING_FETCH: '1' } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve) => child.on('close', resolve));

    const line = stdout.split('\n').find((l) => l.startsWith('RESULT '));
    assert(line, `FeatureFlagManager process failed (exit ${code}): ${stderr || stdout}`);
    return JSON.parse(line.slice('RESULT '.length));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Product checks
// ---------------------------------------------------------------------------

/**
 * Test 1: refresh() gives up on a server that accepts TCP but never answers
 */
async function testRefreshBlackHole() {
  const server = createBlackHoleServer();
  const port = await listenOnRandomPort(server);
  try {
    const { refreshMs, flags } = await runFlagManager(`http://127.0.0.1:${port}/flags.json`, ['refresh']);
    console.log(`   refresh() against black-hole server returned in ${refreshMs}ms (limit: ${MAX_FETCH_MS}ms)`);
    assert(refreshMs < MAX_FETCH_MS, `refresh() hung for ${refreshMs}ms on a black-hole server (issue #465)`);
    assert.deepStrictEqual(flags, {}, 'No flags should be applied when the fetch fails');
  } finally {
    await closeServer(server);
  }
}

/**
 * Test 2: refresh() does not wait for a response slower than its timeout
 */
async function testRefreshSlowResponse() {
  const server = createSlowResponseServer(15000);
  const port = await listenOnRandomPort(server);
  try {
    const { refreshMs, flags } = await runFlagManager(`http://127.0.0.1:${port}/flags.json`, ['refresh']);
    console.log(`   refresh() against 15s response returned in ${refreshMs}ms (limit: ${MAX_FETCH_MS}ms)`);
    assert(refreshMs < MAX_FETCH_MS, `refresh() waited ${refreshMs}ms for a slow response`);
    assert.strictEqual(flags.slow, undefined, 'The late response should not be applied');
  } finally {
    await closeServer(server);
  }
}

/**
 * Test 3: refresh() survives a fetch that ignores AbortController entirely
 *
 * This is the exact #465 failure mode (abort() does not interrupt the TCP connect),
 * reproduced on every platform by replacing fetch with one that never settles.
 */
async function testRefreshFetchIgnoresAbort() {
  const { refreshMs } = await runFlagManager('http://127.0.0.1:9/flags.json', ['refresh'], { hangingFetch: true });
  console.log(`   refresh() with a fetch that ignores abort returned in ${refreshMs}ms (limit: ${MAX_FETCH_MS}ms)`);
  assert(refreshMs < MAX_FETCH_MS, `refresh() hung for ${refreshMs}ms when fetch ignored AbortController (issue #465)`);
}

/**
 * Test 4: New-user startup does not block on a hanging flags server
 *
 * For a new user (no cache), the init handler does:
 *   await featureFlagManager.initialize();
 *   await featureFlagManager.waitForFreshFlags();
 */
async function testNewUserStartup() {
  const server = createBlackHoleServer();
  const port = await listenOnRandomPort(server);
  try {
    const { initializeMs, waitMs } = await runFlagManager(
      `http://127.0.0.1:${port}/flags.json`, ['initialize', 'waitForFreshFlags']
    );
    console.log(`   initialize() took ${initializeMs}ms, waitForFreshFlags() waited ${waitMs}ms`);
    assert(initializeMs < 1000, `initialize() should not wait for the network, took ${initializeMs}ms`);
    assert(waitMs < MAX_FETCH_MS, `waitForFreshFlags() blocked startup for ${waitMs}ms (issue #465)`);
  } finally {
    await closeServer(server);
  }
}

/**
 * Test 5: A healthy flags server still works (the timeout doesn't break normal fetches)
 */
async function testRefreshHealthyServer() {
  const server = createSlowResponseServer(0, { healthy: true });
  const port = await listenOnRandomPort(server);
  try {
    const { refreshMs, flags } = await runFlagManager(`http://127.0.0.1:${port}/flags.json`, ['refresh']);
    console.log(`   refresh() against healthy server returned in ${refreshMs}ms with flags ${JSON.stringify(flags)}`);
    assert.strictEqual(flags.healthy, true, 'Flags from a healthy server should be applied');
  } finally {
    await closeServer(server);
  }
}

// ---------------------------------------------------------------------------
// Platform diagnostics (reported, never fail the run)
// ---------------------------------------------------------------------------

/** How long this platform's fetch takes to honor AbortController against a black hole */
async function measureAbortOnBlackHole(abortAfterMs) {
  const server = createBlackHoleServer();
  const port = await listenOnRandomPort(server);
  try {
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), abortAfterMs);
    const start = Date.now();
    try {
      await fetch(`http://127.0.0.1:${port}/flags.json`, {
        signal: controller.signal,
        headers: { 'Cache-Control': 'no-cache' },
      });
    } catch {
      // Expected: abort error
    }
    clearTimeout(abortTimer);
    return Date.now() - start;
  } finally {
    await closeServer(server);
  }
}

async function reportPlatformDiagnostics() {
  console.log('ℹ️  Platform diagnostics (informational, not pass/fail):');
  for (const abortAfterMs of [2000, FETCH_TIMEOUT_MS]) {
    const elapsed = await measureAbortOnBlackHole(abortAfterMs);
    const affected = elapsed > abortAfterMs + 3000;
    console.log(`   AbortController after ${abortAfterMs}ms interrupted fetch in ${elapsed}ms` +
      (affected ? ' — this platform shows the #465 behavior; the product relies on its Promise.race timeout' : ''));
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  console.log('\n🔍 Feature Flags Timeout Tests (issue #465)\n');
  console.log(`   Node.js: ${process.version}`);
  console.log(`   Platform: ${process.platform}`);
  console.log('');

  await reportPlatformDiagnostics();
  console.log('');

  const results = [];
  results.push(await runTest('refresh() gives up on a black-hole server', testRefreshBlackHole));
  results.push(await runTest('refresh() does not wait for a slow response', testRefreshSlowResponse));
  results.push(await runTest('refresh() survives a fetch that ignores AbortController (#465)', testRefreshFetchIgnoresAbort));
  results.push(await runTest('New-user startup does not block on a hanging flags server', testNewUserStartup));
  results.push(await runTest('A healthy flags server still applies flags', testRefreshHealthyServer));

  console.log('');
  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  if (failed > 0) {
    console.log(`❌ ${failed}/${results.length} test(s) failed`);
    return false;
  }
  console.log(`✅ All ${passed} tests passed`);
  return true;
}

runIfMain(import.meta.url, main);
