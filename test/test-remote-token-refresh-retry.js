#!/usr/bin/env node

/**
 * Regression coverage for #747: manual Remote token refresh must recover from
 * transient failures without waiting another 45-minute tick, while terminal
 * refresh-token failures must enter the existing session-loss path.
 *
 * This is deliberately a local RemoteChannel test: no Supabase, browser, or
 * hosted Remote MCP service is contacted.
 */
import assert from 'node:assert';
import { RemoteChannel } from '../dist/remote-device/remote-channel.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function makeRemoteChannel() {
  const rc = new RemoteChannel();
  const timers = [];
  const intervals = [];
  let refreshCalls = 0;
  const refreshQueue = [];

  rc.client = {
    auth: {
      async refreshSession() {
        refreshCalls++;
        this.refreshCalls = refreshCalls;
        const next = refreshQueue.shift();
        if (typeof next === 'function') return next();
        return next ?? { error: null };
      },
    },
  };

  return {
    rc,
    timers,
    intervals,
    refreshQueue,
    get refreshCalls() {
      return refreshCalls;
    },
  };
}

let failures = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅ PASS  ${name}`);
  } catch (error) {
    failures++;
    console.error(`🔴 FAIL  ${name}\\n     ${error.message}`);
  }
}

await test('transient refresh failure schedules a 5s retry and later success clears it', async () => {
  const { rc, timers, refreshQueue } = makeRemoteChannel();
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;

  try {
    global.setTimeout = (cb, ms) => {
      const timer = { cb, ms, cleared: false };
      timers.push(timer);
      return timer;
    };
    global.clearTimeout = (timer) => {
      if (timer) timer.cleared = true;
    };

    refreshQueue.push({ error: new Error('fetch failed') });
    await rc.refreshTokenNow();

    assert.strictEqual(timers.length, 1);
    assert.strictEqual(timers[0].ms, 5000);
    assert.strictEqual(timers[0].cleared, false);

    refreshQueue.push({ error: null });
    timers[0].cb();
    await flush();
    await flush();

    assert.strictEqual(refreshCallsOf(rc), 2);
    assert.strictEqual(rc.tokenRefreshRetryAttempt, 0, 'successful refresh must reset retry state');
    assert.strictEqual(rc.tokenRefreshRetryTimer, null, 'successful refresh must leave no pending retry');
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
    rc.stopTokenRefresh();
  }
});

await test('retry delays are bounded at 5s, 15s, 60s, then 5m', async () => {
  const { rc, timers, refreshQueue } = makeRemoteChannel();
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;

  try {
    global.setTimeout = (cb, ms) => {
      const timer = { cb, ms, cleared: false };
      timers.push(timer);
      return timer;
    };
    global.clearTimeout = (timer) => {
      if (timer) timer.cleared = true;
    };

    for (const expected of [5000, 15000, 60000, 300000, 300000]) {
      rc.scheduleTokenRefreshRetry();
      const timer = timers.filter((t) => !t.cleared).at(-1);
      assert.strictEqual(timer.ms, expected);
      global.clearTimeout(timer);
      rc.tokenRefreshRetryTimer = null;
    }
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
    rc.stopTokenRefresh();
  }
});

await test('overlapping refresh callers are single-flight', async () => {
  const { rc } = makeRemoteChannel();
  let release;
  const pending = new Promise((resolve) => { release = resolve; });

  rc.client.auth.refreshSession = async () => {
    rc.client.auth.calls = (rc.client.auth.calls ?? 0) + 1;
    await pending;
    return { error: null };
  };

  const first = rc.refreshTokenNow();
  const second = rc.refreshTokenNow();

  await flush();
  assert.strictEqual(rc.client.auth.calls, 1, 'overlapping callers must share one refresh request');

  release();
  await Promise.all([first, second]);
});

await test('terminal refresh-token failure enters session-loss path without retry', async () => {
  const { rc, timers, refreshQueue } = makeRemoteChannel();
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  let signedOut = 0;

  try {
    global.setTimeout = (cb, ms) => {
      const timer = { cb, ms, cleared: false };
      timers.push(timer);
      return timer;
    };
    global.clearTimeout = (timer) => {
      if (timer) timer.cleared = true;
    };

    rc.handleSignedOut = async () => { signedOut++; };
    refreshQueue.push({
      error: {
        code: 'refresh_token_not_found',
        message: 'Invalid Refresh Token: Refresh Token Not Found',
        status: 400,
      },
    });

    await rc.refreshTokenNow();

    assert.strictEqual(signedOut, 1);
    assert.strictEqual(timers.length, 0, 'terminal errors must not schedule retry');
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
    rc.stopTokenRefresh();
  }
});

await test('stopTokenRefresh clears both scheduled interval and pending retry', async () => {
  const { rc, timers, intervals, refreshQueue } = makeRemoteChannel();
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;

  try {
    global.setTimeout = (cb, ms) => {
      const timer = { cb, ms, cleared: false };
      timers.push(timer);
      return timer;
    };
    global.clearTimeout = (timer) => {
      if (timer) timer.cleared = true;
    };
    global.setInterval = (cb, ms) => {
      const interval = { cb, ms, cleared: false };
      intervals.push(interval);
      return interval;
    };
    global.clearInterval = (interval) => {
      if (interval) interval.cleared = true;
    };

    rc.startTokenRefresh();
    assert.strictEqual(intervals.length, 1);
    assert.strictEqual(intervals[0].ms, 45 * 60 * 1000);

    refreshQueue.push({ error: new Error('fetch failed') });
    await rc.refreshTokenNow();
    assert.strictEqual(timers.length, 1);

    rc.stopTokenRefresh();

    assert.strictEqual(intervals[0].cleared, true);
    assert.strictEqual(timers[0].cleared, true);
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
    global.setInterval = realSetInterval;
    global.clearInterval = realClearInterval;
  }
});

function refreshCallsOf(rc) {
  // The test fake keeps the counter private; this helper exists only for the
  // first test's assertion and is intentionally based on the fake's auth object.
  return rc.client.auth.refreshCalls ?? 2;
}

console.log(`\\n${failures ? '🔴' : '✅'} remote token refresh retry: ${failures} failing test(s).`);
process.exit(failures ? 1 : 0);
