/**
 * Shared fixtures for the remote-device tests: one fake Supabase client, one
 * wired-up MCPDevice, one runner. It owns HOME, because config.ts resolves the
 * config path from os.homedir() at module load - a redirect only works before
 * the device is imported, so it happens here rather than per file. Kept out of
 * test/*.js so run-all-tests.js never runs it as a test.
 */
import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'dc-remote-home-'));
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;
process.on('exit', () => {
    try { rmSync(fakeHome, { recursive: true, force: true }); } catch { /* best effort */ }
});

export const { MCPDevice } = await import('../../dist/remote-device/device.js');

export const DEVICE_ID = 'device-1';

/** Cap on waiting for a write to land; far above any healthy save. */
const PERSIST_DEADLINE_MS = 5000;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Stands in for the Supabase client. getSession() snapshots BEFORE its delay:
 * without that, a save cannot read one session and land after a newer one, and
 * the slow-save case stops testing anything.
 */
function makeFakeClient() {
    let currentSession = null;
    let authListener = null;
    const sessionDelays = [];

    return {
        auth: {
            setSession: async ({ access_token, refresh_token }) => {
                currentSession = { access_token, refresh_token };
                return { data: { user: { id: 'user-1', email: 'tester@example.com' } }, error: null };
            },
            getSession: async () => {
                const snapshot = currentSession;
                const delay = sessionDelays.shift() ?? 0;
                if (delay) await sleep(delay);
                return { data: { session: snapshot }, error: null };
            },
            onAuthStateChange: (cb) => {
                authListener = cb;
                return { data: { subscription: { unsubscribe() { } } } };
            },
        },
        realtime: { setAuth: () => { } },

        delaySaves(...msPerSave) {
            sessionDelays.push(...msPerSave);
        },

        signOut() {
            currentSession = null;
        },

        rotate(access_token, refresh_token) {
            currentSession = { access_token, refresh_token };
            authListener?.('TOKEN_REFRESHED', currentSession);
        },
    };
}

/** A device at the point start() reaches once a session is in hand. */
export async function makeDevice(configPath, { deviceId = DEVICE_ID, persist = true } = {}) {
    const device = new MCPDevice();
    device.deviceId = deviceId;
    device.configPath = configPath;

    const client = makeFakeClient();
    const rc = device.remoteChannel;
    rc.client = client; // private in TS, plain property at runtime

    rc.stopHeartbeat = () => { };
    rc.unsubscribe = async () => { };
    rc.setOffline = async () => { };
    device.desktop = { shutdown: async () => { }, listClientTools: async () => ({ tools: [] }) };

    await rc.setSession({ access_token: 'access-1', refresh_token: 'refresh-1' });
    if (persist) await device.savePersistedConfig();

    return { device, client };
}

/** Private in TS, a plain property at runtime, like rc.client above. */
export const drainWrites = (device) => device.configWriteQueue;

export const readPersisted = (configPath) => JSON.parse(readFileSync(configPath, 'utf8'));

export const onDisk = (configPath) => {
    try {
        return readFileSync(configPath, 'utf8');
    } catch {
        return '<absent>';
    }
};

/** Polls: a fixed sleep fails a correct implementation on a loaded machine. */
export async function waitForPersisted(configPath, predicate, timeoutMs = PERSIST_DEADLINE_MS) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        try {
            last = readPersisted(configPath);
            if (predicate(last)) return last;
        } catch { /* absent, or caught mid-write */ }
        await sleep(10);
    }
    return last;
}

/**
 * EPERM on rename is intermittent on Windows, and a failed write leaves the
 * same empty directory as a removal that held. Recorded AND still printed:
 * not every importer runs the assertion below - a child process cannot.
 */
const persistenceErrors = [];
const realConsoleError = console.error;
const realConsoleWarn = console.warn;
const isPersistenceFailure = (args) =>
    typeof args[0] === 'string' &&
    (args[0].includes('Failed to save config') || args[0].includes('Failed to clear stale config'));
console.error = (...args) => {
    if (isPersistenceFailure(args)) persistenceErrors.push(args.map(String).join(' '));
    realConsoleError(...args);
};
console.warn = (...args) => {
    if (isPersistenceFailure(args)) persistenceErrors.push(args.map(String).join(' '));
    realConsoleWarn(...args);
};

/** What has been recorded so far. A child process has no assertion to run. */
export const persistenceFailures = () => [...persistenceErrors];

/** Call before judging what is on disk - including before a precondition. */
export function assertWritesSucceeded() {
    assert.deepStrictEqual(
        persistenceErrors, [],
        'inconclusive, not a defect: a config write or removal reported a failure, so nothing ' +
        `on disk proves anything here - ${persistenceErrors.join('; ')}`
    );
}

/**
 * A runner that gives each case a throwaway config directory and its own view
 * of the persistence-failure watch above.
 */
export function createRunner(label, prefix) {
    let failures = 0;

    async function test(name, fn) {
        const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
        persistenceErrors.length = 0; // each case judges only its own writes
        try {
            await fn(path.join(dir, 'device.json'));
            console.log(`✅ PASS  ${name}`);
        } catch (error) {
            failures++;
            console.error(`🔴 FAIL  ${name}\n     ${error.message}`);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }

    function finish() {
        console.log(`\n${failures ? '🔴' : '✅'} ${label}: ${failures} failing test(s).`);
        process.exit(failures ? 1 : 0);
    }

    return { test, finish };
}
