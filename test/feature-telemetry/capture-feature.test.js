import assert from 'node:assert/strict';
import { configManager } from '../../dist/config-manager.js';
import { captureFeature } from '../../dist/feature-telemetry/capture-feature.js';
import { RemoteChannel } from '../../dist/remote-device/remote-channel.js';
import { runInUiOriginCallContext } from '../../dist/utils/capture.js';

const originalFetch = globalThis.fetch;
const originalGetValue = configManager.getValue;
const originalClientId = configManager.getOrCreateClientId;
const originalOptOut = process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY;
const sent = [];
let mode = 'ok';
let savedClientId = 'installation-1';
let createdIds = 0;
try {
    process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '0';
    configManager.getValue = async key => key === 'clientId' ? savedClientId : key === 'telemetryEnabled' ? true : ['/private/test-folder'];
    configManager.getOrCreateClientId = async () => { createdIds++; return 'installation-new'; };
    globalThis.fetch = async (url, init) => {
        sent.push({ url, ...init });
        if (mode === 'network-failure') throw new TypeError('connection failed');
        return new Response(null, { status: mode === 'primary-failure' && url.includes('telemetry.desktopcommander.app') ? 503 : 204 });
    };
    const properties = { device_id: 'device-1', call_id: 'call-1', details: { enabled: true }, path: '/private/test-folder/file.txt' };
    await captureFeature('feature_used', 'user-1', properties);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, 'https://telemetry.desktopcommander.app/telemetry/feature/mcp/');
    assert.equal(sent[0].method, 'POST');
    assert.equal(sent[0].headers['Content-Type'], 'application/json');
    assert.ok(sent[0].signal instanceof AbortSignal);
    const body = JSON.parse(sent[0].body);
    assert.equal(body.user_id, 'user-1');
    assert.equal(body.client_id, 'installation-1');
    assert.equal(createdIds, 0, 'an existing client ID must not rewrite the configuration');
    assert.equal(new Date(body.timestamp_utc).toISOString(), body.timestamp_utc);
    assert.equal(body.telemetry_type, undefined);
    const event = body.events[0];
    assert.equal(event.name, 'feature_used');
    assert.deepEqual(event.params.details, { enabled: true });
    assert.equal(event.params.call_id, 'call-1');
    assert.equal(event.params.device_id, 'device-1');
    assert.match(event.params.observation_id, /^[0-9a-f-]{36}$/);
    assert.equal(event.params.path, undefined);
    assert.equal(properties.path, '/private/test-folder/file.txt');

    mode = 'primary-failure';
    await captureFeature('feature_used', 'user-1', properties);
    assert.equal(sent.length, 3);
    assert.equal(sent[2].url, 'https://dc-telemetry-proxy-83847352264.europe-west1.run.app/telemetry/feature/mcp/');
    assert.equal(sent[1].body, sent[2].body, 'fallback retains the timestamp and observation ID');
    mode = 'network-failure';
    await assert.doesNotReject(() => captureFeature('feature_used', 'user-1', properties));
    assert.equal(sent.length, 5, 'both hosts fail without interrupting the caller');
    assert.equal(createdIds, 0);

    mode = 'ok';
    savedClientId = undefined;
    await captureFeature('feature_used', 'user-1', properties);
    assert.equal(createdIds, 1, 'create the client ID only when missing');
    assert.equal(JSON.parse(sent[5].body).client_id, 'installation-new');
    process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
    await captureFeature('feature_used', 'user-1', properties);
    process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '0';
    configManager.getValue = async () => false;
    await captureFeature('feature_used', 'user-1', properties);
    configManager.getValue = async () => true;
    await runInUiOriginCallContext(() => captureFeature('feature_used', 'user-1', properties));
    await captureFeature('feature_used', '', properties);
    await captureFeature('feature_used', 'user-1', { device_id: '' });
    assert.equal(sent.length, 6, 'opt-outs and missing identity produce no requests');

    configManager.getValue = async key => key === 'clientId' ? 'installation-1' : key === 'telemetryEnabled' ? true : [];
    const channel = new RemoteChannel('https://backend.example');
    channel.client = {};
    channel.deviceId = 'device-1';
    channel._user = { id: 'user-1' };
    channel.getAccessToken = async () => 'device-token';
    channel.sleep = async () => {};
    const featureFetch = globalThis.fetch;
    const claims = [];
    let claimRequests = 0;
    let resolveClaims;
    const claimsSent = new Promise(resolve => { resolveClaims = resolve; });
    globalThis.fetch = async (url, init) => {
        if (new URL(url).hostname === 'backend.example') {
            if (++claimRequests === 1) throw new TypeError('connection lost');
            return new Response(JSON.stringify({ data: [{ id: 'call-1', status: 'executing' }] }));
        }
        assert.equal(new URL(url).pathname, '/telemetry/feature/mcp/');
        claims.push(JSON.parse(init.body));
        if (claims.length === 2) resolveClaims();
        return featureFetch(url, init);
    };
    await channel.onDoorbell({ call_id: 'call-1', device_id: 'device-1' });
    let claimTimeout;
    try {
        await Promise.race([claimsSent, new Promise((_, reject) => {
            claimTimeout = setTimeout(() => reject(new Error('Claim feature events were not sent')), 3000);
        })]);
    } finally {
        clearTimeout(claimTimeout);
    }
    assert.equal(claims.length, claimRequests, 'each claim attempt emits feature telemetry, including a failed request');
    assert.equal(claims.length, 2);
    for (const claim of claims) {
        assert.equal(claim.user_id, 'user-1');
        assert.equal(claim.client_id, 'installation-1');
        assert.equal(claim.events[0].name, 'claim_after_doorbell_requested');
        assert.equal(claim.events[0].params.call_id, 'call-1');
        assert.equal(claim.events[0].params.device_id, 'device-1');
        assert.equal(claim.events[0].params.stage, undefined);
        assert.equal(new Date(claim.timestamp_utc).toISOString(), claim.timestamp_utc);
    }
} finally {
    globalThis.fetch = originalFetch;
    configManager.getValue = originalGetValue;
    configManager.getOrCreateClientId = originalClientId;
    if (originalOptOut === undefined) delete process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY;
    else process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = originalOptOut;
}
console.log('PASS feature telemetry: envelope, privacy, fallback, failures and opt-outs');
