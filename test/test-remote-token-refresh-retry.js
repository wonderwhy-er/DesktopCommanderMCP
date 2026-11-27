import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError } from '@supabase/supabase-js';
import { RemoteChannel } from '../dist/remote-device/remote-channel.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
const transient = () => new AuthRetryableFetchError('simulated offline', 0);
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function harness(t, refreshSession) {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const rc = new RemoteChannel();
    rc.client = { auth: { refreshSession } };
    rc.startTokenRefresh();
    t.after(() => rc.stopTokenRefresh());
    return rc;
}

test('transient failure retries at 5s, success resumes the normal cadence', async t => {
    let calls = 0;
    const rc = harness(t, async () => ({ error: ++calls === 1 ? transient() : null }));
    await rc.refreshTokenNow();
    t.mock.timers.tick(4999); await flush(); assert.equal(calls, 1);
    t.mock.timers.tick(1); await flush(); assert.equal(calls, 2);
    assert.equal(rc.tokenRefreshRetry, null);
    t.mock.timers.tick(300000); await flush(); assert.equal(calls, 2);
    t.mock.timers.tick(45 * 60000 - 305000); await flush(); assert.equal(calls, 3);
});

test('continued network failure uses 5s, 15s, 60s, then a 5 minute cap', async t => {
    let calls = 0;
    const rc = harness(t, async () => { calls++; throw transient(); });
    await rc.refreshTokenNow();
    for (const delay of [5000, 15000, 60000, 300000, 300000]) {
        const before = calls;
        t.mock.timers.tick(delay - 1); await flush(); assert.equal(calls, before);
        t.mock.timers.tick(1); await flush(); assert.equal(calls, before + 1);
    }
});

test('concurrent refresh callers share one request', async t => {
    let release, calls = 0;
    const rc = harness(t, () => { calls++; return new Promise(resolve => { release = resolve; }); });
    const first = rc.refreshTokenNow();
    const second = rc.refreshTokenNow();
    assert.equal(first, second); assert.equal(calls, 1);
    release({ error: null }); await first;
});

test('stop cancels retries and a late response cannot re-arm them', async t => {
    let calls = 0;
    const rc = harness(t, async () => { calls++; return { error: transient() }; });
    await rc.refreshTokenNow(); rc.stopHeartbeat();
    t.mock.timers.tick(45 * 60000); await flush(); assert.equal(calls, 1);
    let release;
    rc.client.auth.refreshSession = () => new Promise(resolve => { release = resolve; });
    rc.startTokenRefresh();
    const pending = rc.refreshTokenNow(); rc.stopHeartbeat();
    release({ error: transient() }); await pending;
    assert.equal(rc.tokenRefreshRetry, null);
});

for (const status of [429, 500, 503]) {
    test(`HTTP ${status} retries instead of waiting 45 minutes`, async t => {
        let calls = 0;
        const rc = harness(t, async () => ({ error: ++calls === 1 ? new AuthApiError('simulated server error', status) : null }));
        await rc.refreshTokenNow();
        t.mock.timers.tick(5000); await flush(); assert.equal(calls, 2);
    });
}

for (const code of ['refresh_token_not_found', 'refresh_token_already_used', 'session_not_found', 'session_expired']) {
test(`${code} takes the real one-shot restore/offline path`, async t => {
    const error = new AuthApiError('simulated revoked token', 400, code);
    let refreshCalls = 0, restoreCalls = 0, offlineCalls = 0;
    const rc = harness(t, async () => { refreshCalls++; return { error }; });
    rc.lastKnownSession = { access_token: 'test-access', refresh_token: 'test-refresh' };
    rc.client.auth.setSession = async () => { restoreCalls++; return { error }; };
    rc.client.realtime = { disconnect() {} };
    rc.setOffline = async () => { offlineCalls++; };
    await rc.refreshTokenNow();
    assert.equal(rc.sessionLost, true);
    assert.equal(restoreCalls, 1); assert.equal(offlineCalls, 1);
    t.mock.timers.tick(45 * 60000); await flush(); assert.equal(refreshCalls, 1);
});
}

test('a missing session enters the existing offline path', async t => {
    const rc = harness(t, async () => ({ error: new AuthSessionMissingError() }));
    rc.client.realtime = { disconnect() {} };
    let offlineCalls = 0;
    rc.setOffline = async () => { offlineCalls++; };
    await rc.refreshTokenNow();
    assert.equal(rc.sessionLost, true); assert.equal(offlineCalls, 1);
    assert.equal(rc.tokenRefreshRetry, null);
});

test('success resets the backoff before a later network failure', async t => {
    let calls = 0;
    const rc = harness(t, async () => ({ error: ++calls === 3 ? null : transient() }));
    await rc.refreshTokenNow();
    t.mock.timers.tick(5000); await flush();
    t.mock.timers.tick(15000); await flush(); assert.equal(calls, 3);
    await rc.refreshTokenNow(); assert.equal(calls, 4);
    t.mock.timers.tick(4999); await flush(); assert.equal(calls, 4);
    t.mock.timers.tick(1); await flush(); assert.equal(calls, 5);
});

test('unknown non-retryable auth error does not enter a fast retry loop', async t => {
    let calls = 0;
    const rc = harness(t, async () => { calls++; return { error: new AuthApiError('simulated forbidden', 403) }; });
    await rc.refreshTokenNow();
    t.mock.timers.tick(300000); await flush(); assert.equal(calls, 1);
    assert.equal(rc.tokenRefreshRetry, null);
});
