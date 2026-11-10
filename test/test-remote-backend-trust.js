#!/usr/bin/env node
/**
 * Regression coverage for the Remote MCP startup credential boundary.
 * A compromised /api/mcp-info response must not redirect a saved session
 * toward a different Supabase project, even one with valid HTTPS.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
    DEFAULT_REMOTE_SERVER_URL,
    PRODUCTION_SUPABASE_ORIGIN,
    savedSessionMatchesContext,
    validateRemoteAuthContext,
    validateRemoteServerUrl,
} from '../dist/remote-device/remote-utils.js';
import { MCPDevice, logoutRemoteDevice } from '../dist/remote-device/device.js';
import { runIfMain } from './helpers/run-if-main.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

async function runTests() {
    const production = validateRemoteAuthContext(DEFAULT_REMOTE_SERVER_URL, PRODUCTION_SUPABASE_ORIGIN);
    assert.deepEqual(production, {
        serverOrigin: DEFAULT_REMOTE_SERVER_URL,
        supabaseUrl: PRODUCTION_SUPABASE_ORIGIN,
    });

    for (const value of [
        'http://example.com', 'http://192.168.1.2:3007',
        'https://user:pass@mcp.desktopcommander.app',
        'https://mcp.desktopcommander.app/path',
        'https://mcp.desktopcommander.app/?token=1',
        'https://mcp.desktopcommander.app/#hash',
        'file:///etc/passwd', 'not-a-url',
    ]) {
        assert.throws(() => validateRemoteServerUrl(value), /Unsafe|Invalid/, value);
    }
    assert.equal(validateRemoteServerUrl('http://127.0.0.1:3007').origin, 'http://127.0.0.1:3007');
    assert.equal(validateRemoteServerUrl('http://mcp.localhost:3007').origin, 'http://mcp.localhost:3007');
    assert.equal(validateRemoteServerUrl('https://custom.example').origin, 'https://custom.example');

    for (const value of [
        'https://rogue.supabase.co',
        'http://olvbkozcufcbptfogatw.supabase.co',
        'https://user:pass@olvbkozcufcbptfogatw.supabase.co',
        'https://olvbkozcufcbptfogatw.supabase.co/different-path',
        'https://olvbkozcufcbptfogatw.supabase.co?changed=1',
    ]) {
        assert.throws(() => validateRemoteAuthContext(DEFAULT_REMOTE_SERVER_URL, value), /Unsafe|Unexpected/, value);
    }

    const custom = validateRemoteAuthContext('https://custom.example', 'https://custom-supabase.example/rest-root/');
    assert.equal(custom.supabaseUrl, 'https://custom-supabase.example/rest-root');
    assert.equal(validateRemoteAuthContext('http://127.0.0.1:3007', 'http://127.0.0.1:3007').supabaseUrl, 'http://127.0.0.1:3007');
    assert.equal(savedSessionMatchesContext(undefined, production), true, 'legacy production session must keep working');
    assert.equal(savedSessionMatchesContext(undefined, custom), false, 'legacy custom session cannot be safely attributed');
    assert.equal(savedSessionMatchesContext(production, production), true);
    assert.equal(savedSessionMatchesContext(custom, custom), true);
    assert.equal(savedSessionMatchesContext(production, custom), false);
    assert.equal(savedSessionMatchesContext({...custom, supabaseUrl: 'https://other.example'}, custom), false);
    assert.equal(savedSessionMatchesContext({...custom, serverOrigin: 'https://other.example'}, custom), false);

    const originalFetch = globalThis.fetch;
    const originalServer = process.env.MCP_SERVER_URL;
    process.env.MCP_SERVER_URL = DEFAULT_REMOTE_SERVER_URL;
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-auth-trust-'));
    try {
        const device = new MCPDevice();
        globalThis.fetch = async (_url, init) => {
            assert.equal(init.redirect, 'error', 'configuration fetch must reject redirects');
            assert.equal(new URL(_url).origin, DEFAULT_REMOTE_SERVER_URL);
            return {
                ok: true, headers: new Headers({date: new Date().toUTCString()}),
                json: async () => ({
                    supabaseUrl: 'https://rogue.supabase.co',
                    supabasePublishableKey: 'test-key',
                }),
            };
        };
        await assert.rejects(device.fetchSupabaseConfig(), /Unexpected Supabase backend/);
        assert.equal(device.trustedAuthContext, null, 'failed configuration cannot arm session restoration');

        globalThis.fetch = async (_url, init) => {
            assert.equal(init.redirect, 'error');
            return {
                ok: true, headers: new Headers({date: new Date().toUTCString()}),
                json: async () => ({
                    supabaseUrl: PRODUCTION_SUPABASE_ORIGIN,
                    supabasePublishableKey: 'test-key',
                }),
            };
        };
        await device.fetchSupabaseConfig();
        assert.deepEqual(device.trustedAuthContext, production);

        const configPath = path.join(home, 'device.json');
        device.configPath = configPath;
        const session = { access_token: 'saved-access', refresh_token: 'saved-refresh' };
        await fs.writeFile(configPath, JSON.stringify({deviceId: 'device-1', session}));
        assert.deepEqual(await device.loadPersistedConfig(), session, 'legacy production session still loads');

        const customDevice = new MCPDevice();
        customDevice.configPath = configPath;
        customDevice.trustedAuthContext = custom;
        assert.equal(await customDevice.loadPersistedConfig(), null, 'custom backend must not reuse legacy tokens');
        assert.equal(customDevice.deviceId, undefined, 'cross-backend device ID must not be reused');
        assert.deepEqual(JSON.parse(await fs.readFile(configPath, 'utf8')).session, session, 'rejected tokens must be kept until re-authorization');

        process.env.MCP_SERVER_URL = 'https://custom.example';
        await assert.rejects(
            logoutRemoteDevice(configPath),
            /Saved session belongs to another or unknown backend/,
            'logout must not send a legacy token to an unexpected MCP server',
        );
        assert.deepEqual(JSON.parse(await fs.readFile(configPath, 'utf8')).session, session);
    } finally {
        globalThis.fetch = originalFetch;
        if (originalServer === undefined) delete process.env.MCP_SERVER_URL;
        else process.env.MCP_SERVER_URL = originalServer;
        await fs.rm(home, { recursive: true, force: true });
    }
    console.log('✅ Remote MCP authentication backend trust tests passed');
}

runIfMain(import.meta.url, runTests);
