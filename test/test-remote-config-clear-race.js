#!/usr/bin/env node

/**
 * Pins that clearing the persisted device config actually clears it, and that
 * a config carrying a session but no device id is neither written nor read.
 * Runs against ./helpers/remote-device-harness.js - no network, no browser.
 */
import assert from 'node:assert';
import { existsSync, writeFileSync } from 'node:fs';
import {
    MCPDevice,
    DEVICE_ID,
    makeDevice,
    drainWrites,
    onDisk,
    readPersisted,
    assertWritesSucceeded,
    createRunner,
} from './helpers/remote-device-harness.js';

const { test, finish } = createRunner('remote config clear race', 'dc-695-');

await test('a save in flight cannot outlive the clear that was meant to erase it', async (configPath) => {
    const { device, client } = await makeDevice(configPath);
    assert.ok(existsSync(configPath), 'precondition: startup persisted a config');

    client.delaySaves(300);
    const inFlight = device.savePersistedConfig();
    client.rotate('access-2', 'refresh-2');

    await device.clearPersistedConfig();
    await inFlight;
    await drainWrites(device);
    assertWritesSucceeded();

    const restarted = new MCPDevice();
    restarted.configPath = configPath;
    const loaded = await restarted.loadPersistedConfig();

    assert.strictEqual(
        loaded, null,
        'the clear was overtaken by a queued write, so a revoked device keeps a usable session ' +
        `on disk and the next start skips the revocation check (on disk: ${onDisk(configPath)})`
    );
});

await test('a rotation announced after the clear does not restore the credentials', async (configPath) => {
    const { device, client } = await makeDevice(configPath);
    assert.ok(existsSync(configPath), 'precondition: startup persisted a config');

    await device.clearPersistedConfig();
    assertWritesSucceeded();
    assert.ok(!existsSync(configPath), 'precondition: the clear removed the file');

    device.deviceId = undefined;
    client.rotate('access-2', 'refresh-2');
    await drainWrites(device);
    assertWritesSucceeded();

    const restarted = new MCPDevice();
    restarted.configPath = configPath;
    const loaded = await restarted.loadPersistedConfig();

    assert.strictEqual(
        loaded, null,
        'a refresh of the revoked session wrote the credentials back after the clear, and with ' +
        'no deviceId alongside them the next start skips the revocation check entirely ' +
        `(deviceId=${restarted.deviceId}, on disk: ${onDisk(configPath)})`
    );

    // Control: without it the case passes against a savePersistedConfig()
    // gutted into doing nothing at all.
    device.deviceId = DEVICE_ID;
    client.rotate('access-3', 'refresh-3');
    await drainWrites(device);
    assertWritesSucceeded();

    assert.strictEqual(
        readPersisted(configPath)?.session?.refresh_token, 'refresh-3',
        'control: a rotation carrying a device id no longer persists at all, so the assertion ' +
        'above proves a dead write path rather than a refused shape'
    );
});

await test('a config already on disk without a device id is not a session', async (configPath) => {
    // Tokens of its own: matching ones would let a file merely left alone
    // pass for one that was rewritten.
    writeFileSync(configPath, JSON.stringify({
        session: { access_token: 'stale-access', refresh_token: 'stale-refresh' },
    }, null, 2));

    const { device } = await makeDevice(configPath, { deviceId: undefined, persist: false });
    const loaded = await device.loadPersistedConfig();

    assert.strictEqual(
        loaded, null,
        'start() restores this session, finds no device id and so skips the revocation check ' +
        'that if (this.deviceId) guards, then dies in registerDevice() with "Device not found: ' +
        'undefined" - on every restart, with nothing on the machine ever changing. The invariant ' +
        'holds on the write side only, so an existing config is never read back out of that loop'
    );

    // Without this the claim that the stale file is replaced goes unasserted.
    device.deviceId = DEVICE_ID;
    await device.savePersistedConfig();
    assertWritesSucceeded();

    assert.deepStrictEqual(
        readPersisted(configPath),
        { deviceId: DEVICE_ID, session: { access_token: 'access-1', refresh_token: 'refresh-1' } },
        'the refused config survived a successful authorization - either untouched, or with the ' +
        'stale tokens carried into it - so the next start reads an id-less session again'
    );
});

await test('a queued rotation keeps the device id it was announced under', async (configPath) => {
    const { device, client } = await makeDevice(configPath);

    client.rotate('access-2', 'refresh-2');
    device.deviceId = 'device-2';

    await drainWrites(device);
    assertWritesSucceeded();

    const config = readPersisted(configPath);
    assert.deepStrictEqual(
        { deviceId: config.deviceId, refresh_token: config.session?.refresh_token },
        { deviceId: DEVICE_ID, refresh_token: 'refresh-2' },
        'the write took the device id that was current when it ran instead of the one current ' +
        'when the rotation was announced, so the config pairs one device with a session that ' +
        'belonged to another'
    );
});

finish();
