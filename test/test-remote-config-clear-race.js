#!/usr/bin/env node

/**
 * Regression test for DC-695 (#695): clearing the persisted device config has
 * to actually clear it.
 *
 * Every write to `device.json` goes through `configWriteQueue`, which exists so
 * that two saves in flight land in the order they were queued. The removal does
 * not: `clearPersistedConfig()` calls fs.rm directly. A save queued a moment
 * earlier therefore lands AFTER the removal and puts the file back.
 *
 * The only caller is the revoked-device branch of `start()`: the server no
 * longer knows this device, so the local credentials must go and the next start
 * must demand a fresh browser authorization. A rotation announced while that
 * branch is running is exactly the write that outlives it - the 45-minute
 * refresh has no idea a revocation check is in progress.
 *
 * What it costs on the headless machines of DC-695: start() clears, sets
 * deviceId to undefined, and falls through to DeviceAuthenticator. That
 * authorization has nobody to complete it, the process exits, and the config
 * left behind holds a live session and no deviceId. The next start loads the
 * session, finds no deviceId, skips the revocation check that is guarded by
 * one, and then dies in registerDevice() - which looks a device up and never
 * creates one, so an absent id is 'Device not found: undefined'. Under
 * systemd with Restart=always that is a restart loop nobody can see.
 *
 * The second case is a different mechanism with the same ending. Ordering only
 * governs writes already queued; the clear does nothing about the ones still to
 * come. start() sets deviceId to undefined and then spends up to fifteen
 * minutes in DeviceAuthenticator, while the Supabase client still holds the old
 * session and the TOKEN_REFRESHED listener is still live. The refresh cadence
 * fires against credentials that were just revoked and writes them back - this
 * time without a deviceId, which is the shape that makes the next start skip
 * the revocation check.
 *
 * The third case is the state, not the sequence: a config that some earlier
 * version already wrote. Refusing to write that shape does nothing for a
 * machine already holding one, and reading it back is what keeps that machine
 * where it is.
 *
 * Drives the real MCPDevice against a fake Supabase client and a throwaway
 * config file - see ./helpers/remote-device-harness.js, which also moves HOME
 * before the device module is loaded. No network, no browser, no Supabase.
 *
 * Standalone:
 *   npm run build && node test/test-remote-config-clear-race.js
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

    // A save is in flight when the clear runs - the case configWriteQueue
    // exists for. The rotation behind it is what the 45-minute refresh queues
    // while start() is still asking the server whether this device was revoked.
    client.delaySaves(300);
    const inFlight = device.savePersistedConfig();
    client.rotate('access-2', 'refresh-2');

    await device.clearPersistedConfig();
    await inFlight;
    await drainWrites(device);
    assertWritesSucceeded();

    // Say it the way a restart sees it: the credentials must be gone.
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

    // What start() does next: drop the device id and hand over to
    // DeviceAuthenticator, which waits on a browser for up to fifteen minutes.
    // Nothing tells the old session to stop refreshing while that happens.
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

    // Control: the write path still works, and only this shape was refused.
    // Without it the case would pass just as well against a savePersistedConfig()
    // that had been gutted into doing nothing at all.
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
    // Exactly what a device running 0.2.51 could be left holding: the clear
    // ran, the device id was dropped, and a rotation of the revoked session
    // wrote itself back. Refusing to write that shape stops it being made from
    // now on; it does nothing for the machines already holding one, and those
    // are the machines this report is about.
    // Tokens of its own, different from the ones the live session carries.
    // Matching ones would let a file that was merely left alone pass for a
    // file that was rewritten.
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

    // And the stale file does not outlive the authorization that follows:
    // start() assigns the device id it was given and persists, replacing what
    // was there with a whole config. Without this the case would leave the
    // claim that the file is replaced entirely unasserted.
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

    // A rotation is announced now and written a moment later, off the queue.
    // start() reassigns the device id inside exactly that gap - once when a
    // revoked device is cleared, and again when authenticate() answers with a
    // new one.
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
