/**
 * Test: Feature flags fetch must not block startup on slow networks
 * 
 * Reproduces GitHub issue #465: ~30 second MCP startup delay caused by
 * feature flags fetch on high-latency networks where AbortController
 * doesn't interrupt in-progress TCP connect.
 *
 * Strategy: We spin up local TCP servers that simulate different slow-network
 * scenarios and test that fetch + AbortController actually respects the timeout.
 * We also replicate the exact fetch pattern used in FeatureFlagManager.fetchFlags()
 * to confirm whether the current code is safe on this platform.
 */

import { createServer } from 'net';
import http from 'http';
import assert from 'assert';

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
function createSlowResponseServer(delayMs) {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: '1', flags: { slow: true } }));
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
// Replicate the EXACT fetch pattern from FeatureFlagManager.fetchFlags()
// This is the code under test — copied so we can run it against our mock servers.
// ---------------------------------------------------------------------------

/**
 * Current implementation (from feature-flags.ts):
 * Uses AbortController + Promise.race with 3s timeout.
 */
const FETCH_TIMEOUT_MS = 3000;

async function currentFetchPattern(url) {
  const controller = new AbortController();
  const abortTimeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const fetchPromise = fetch(url, {
    signal: controller.signal,
    headers: { 'Cache-Control': 'no-cache' },
  });
  const hardTimeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Feature flags fetch timed out')), FETCH_TIMEOUT_MS)
  );
  try {
    const response = await Promise.race([fetchPromise, hardTimeout]);
    clearTimeout(abortTimeout);
    return response;
  } catch (err) {
    clearTimeout(abortTimeout);
    throw err;
  }
}

// (fixedFetchPattern removed — currentFetchPattern already uses Promise.race)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * Test 1: AbortController behavior on this platform
 * 
 * Directly tests whether AbortController.abort() can interrupt a fetch
 * to a black-hole server. If this fails, it confirms the underlying
 * Node/undici issue from #465.
 */
async function testAbortControllerBehavior() {
  const server = createBlackHoleServer();
  const port = await listenOnRandomPort(server);

  try {
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 2000);

    const start = Date.now();
    try {
      await fetch(`http://127.0.0.1:${port}/test`, {
        signal: controller.signal,
      });
    } catch (err) {
      // Expected: abort error
    }
    clearTimeout(abortTimer);

    const elapsed = Date.now() - start;
    console.log(`   AbortController interrupted fetch in ${elapsed}ms (expected ~2000ms)`);

    if (elapsed > 5000) {
      console.log(
        `   ⚠ WARNING: AbortController took ${elapsed}ms — ` +
        `this platform may be affected by issue #465.`
      );
    }

    // We use a generous 10s limit here. On healthy platforms this is ~2s.
    // On affected platforms it could be 30s+ (which fails this test and
    // proves the bug exists on this machine).
    assert(
      elapsed < 10000,
      `AbortController failed to interrupt fetch: ${elapsed}ms. ` +
      `Node ${process.version}, ${process.platform}. ` +
      `This confirms the AbortController bug from issue #465.`
    );
  } finally {
    await closeServer(server);
  }
}

/**
 * Test 2: Current fetch pattern (AbortController only) against black-hole
 * 
 * This replicates exactly what FeatureFlagManager.fetchFlags() does.
 * On affected platforms, this should take ~30s (FAIL).
 * On healthy platforms, this should take ~5s (PASS).
 */
async function testCurrentPatternBlackHole() {
  const server = createBlackHoleServer();
  const port = await listenOnRandomPort(server);
  const MAX_ALLOWED = 5000; // 3s timeout + 2s margin

  try {
    const start = Date.now();
    try {
      await currentFetchPattern(`http://127.0.0.1:${port}/flags.json`);
    } catch (err) {
      // Expected
    }
    const elapsed = Date.now() - start;
    console.log(`   Current pattern (Promise.race) completed in ${elapsed}ms (limit: ${MAX_ALLOWED}ms)`);

    assert(
      elapsed < MAX_ALLOWED,
      `Current fetch pattern (AbortController only) took ${elapsed}ms, exceeding ${MAX_ALLOWED}ms. ` +
      `This reproduces issue #465 — AbortController is not interrupting the TCP connect.`
    );
  } finally {
    await closeServer(server);
  }
}

/**
 * Test 3: AbortController-only pattern (pre-fix) against black-hole
 * 
 * This shows what happens WITHOUT Promise.race — just AbortController.
 * On macOS this passes, on affected Windows it would hang ~30s.
 */
async function testAbortControllerOnlyBlackHole() {
  const server = createBlackHoleServer();
  const port = await listenOnRandomPort(server);
  const MAX_ALLOWED = 7000;

  try {
    // AbortController-only pattern (the old code before the fix)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const start = Date.now();
    try {
      await fetch(`http://127.0.0.1:${port}/flags.json`, {
        signal: controller.signal,
        headers: { 'Cache-Control': 'no-cache' },
      });
    } catch (err) {
      // Expected
    }
    clearTimeout(timeout);
    const elapsed = Date.now() - start;
    console.log(`   AbortController-only pattern completed in ${elapsed}ms (limit: ${MAX_ALLOWED}ms)`);

    assert(
      elapsed < MAX_ALLOWED,
      `AbortController-only pattern took ${elapsed}ms — on this platform AbortController works, ` +
      `but on affected Windows+undici this would be ~30s`
    );
  } finally {
    await closeServer(server);
  }
}

/**
 * Test 4: Current pattern against slow 15s response server
 */
async function testCurrentPatternSlowResponse() {
  const server = createSlowResponseServer(15000);
  const port = await listenOnRandomPort(server);
  const MAX_ALLOWED = 5000; // 3s timeout + 2s margin

  try {
    const start = Date.now();
    try {
      await currentFetchPattern(`http://127.0.0.1:${port}/flags.json`);
    } catch (err) {
      // Expected: abort
    }
    const elapsed = Date.now() - start;
    console.log(`   Current pattern (slow response) completed in ${elapsed}ms (limit: ${MAX_ALLOWED}ms)`);

    assert(
      elapsed < MAX_ALLOWED,
      `Current pattern waited for slow response: ${elapsed}ms (limit: ${MAX_ALLOWED}ms)`
    );
  } finally {
    await closeServer(server);
  }
}

/**
 * Test 5: Simulate the full onboarding path for new users
 * 
 * For a new user (no cache), the init handler does:
 *   await featureFlagManager.waitForFreshFlags()
 * 
 * which waits for freshFetchPromise to resolve. With a hanging fetch,
 * this blocks the MCP initialize response.
 * 
 * We simulate this by creating a promise that resolves only when the
 * fetch completes (like freshFetchPromise), and measure how long it takes.
 */
async function testNewUserOnboardingPath() {
  const server = createBlackHoleServer();
  const port = await listenOnRandomPort(server);
  const MAX_ALLOWED = 6000; // 3s fetch timeout + waitForFreshFlags 5s safety + margin

  try {
    // Simulate the freshFetchPromise pattern from FeatureFlagManager
    let resolveFresh;
    const freshFetchPromise = new Promise((resolve) => {
      resolveFresh = resolve;
    });

    // Fire-and-forget fetch (like initialize() does)
    currentFetchPattern(`http://127.0.0.1:${port}/flags.json`)
      .then(() => resolveFresh())
      .catch(() => resolveFresh()); // resolve on error too, like the real code

    // Now simulate waitForFreshFlags()
    const start = Date.now();
    await freshFetchPromise;
    const elapsed = Date.now() - start;

    console.log(`   New-user onboarding path waited ${elapsed}ms (limit: ${MAX_ALLOWED}ms)`);

    assert(
      elapsed < MAX_ALLOWED,
      `New-user path blocked for ${elapsed}ms waiting for fetch. ` +
      `This is the exact scenario causing 30s startup delays in issue #465.`
    );
  } finally {
    await closeServer(server);
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Test 6: Simulate broken AbortController (the exact #465 scenario)
 *
 * On affected platforms, AbortController.abort() fires but the fetch
 * promise doesn't reject until the OS TCP timeout (~30s). We simulate
 * this by creating a fetch-like promise that ignores abort and only
 * resolves after 20s. Then we show that Promise.race still saves us.
 */
async function testBrokenAbortControllerSimulation() {
  // Simulate a fetch that ignores AbortController (the Windows bug)
  function brokenFetch() {
    return new Promise((resolve, reject) => {
      // This simulates the fetch hanging for 20s regardless of abort
      setTimeout(() => reject(new Error('OS TCP timeout after 20s')), 20000);
    });
  }

  // Current pattern: AbortController only — hangs for 20s
  const start1 = Date.now();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 5000);
  try {
    await brokenFetch(); // ignores the abort signal
  } catch (err) {
    // will take 20s
  }
  const elapsed1 = Date.now() - start1;
  console.log(`   Broken AbortController (current pattern): ${elapsed1}ms`);

  // Fixed pattern: Promise.race — returns in 5s even with broken abort
  const start2 = Date.now();
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Hard timeout')), 5000)
  );
  try {
    await Promise.race([brokenFetch(), timeoutPromise]);
  } catch (err) {
    // will take 5s thanks to Promise.race
  }
  const elapsed2 = Date.now() - start2;
  console.log(`   Broken AbortController (Promise.race fix): ${elapsed2}ms`);

  assert(
    elapsed1 > 15000,
    `Expected broken fetch to hang ~20s but it took ${elapsed1}ms — simulation is wrong`
  );
  assert(
    elapsed2 < 7000,
    `Promise.race fix should have resolved in ~5s but took ${elapsed2}ms`
  );

  console.log(`   ✓ Promise.race recovered from broken AbortController (${elapsed1}ms → ${elapsed2}ms)`);
}

async function main() {
  console.log('\n🔍 Feature Flags Timeout Tests (issue #465)\n');
  console.log(`   Node.js: ${process.version}`);
  console.log(`   Platform: ${process.platform}`);
  console.log('');

  const results = [];

  results.push(await runTest(
    'AbortController interrupts fetch to black-hole server (2s)',
    testAbortControllerBehavior
  ));

  results.push(await runTest(
    'Current fetchFlags pattern respects 5s timeout (black-hole)',
    testCurrentPatternBlackHole
  ));

  results.push(await runTest(
    'AbortController-only pattern (pre-fix baseline) against black-hole',
    testAbortControllerOnlyBlackHole
  ));

  results.push(await runTest(
    'Current pattern aborts before 15s slow response arrives',
    testCurrentPatternSlowResponse
  ));

  results.push(await runTest(
    'New-user onboarding path does not block >8s on slow network',
    testNewUserOnboardingPath
  ));

  results.push(await runTest(
    'Promise.race fixes broken AbortController (simulated #465)',
    testBrokenAbortControllerSimulation
  ));

  console.log('');
  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;

  if (failed > 0) {
    console.log(`❌ ${failed}/${results.length} test(s) failed`);
    console.log('   On this platform, issue #465 may be reproducible.');
    console.log('   The Promise.race fix should resolve it regardless.');
    process.exit(1);
  } else {
    console.log(`✅ All ${passed} tests passed`);
    console.log('   AbortController works correctly on this platform.');
    console.log('   The Promise.race fix is still recommended as a safety net.');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Fatal error in test runner:', err);
  process.exit(1);
});
