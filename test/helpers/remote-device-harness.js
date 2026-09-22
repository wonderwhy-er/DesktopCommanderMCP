/**
 * Shared fixtures for the remote-device tests.
 *
 * One fake Supabase client, one wired-up MCPDevice, one runner. They used to be
 * copied per test file, and the copies had already drifted - one grew signOut(),
 * the other rotate(), and only one of them stubbed the teardown surface. A fake
 * that models auth-js is the sort of thing a second reader assumes is the same
 * in both files, so it is kept in one.
 *
 * It also owns the home directory the device module graph is loaded against.
 * config.ts resolves CONFIG_FILE from os.homedir() at module load, so the only
 * place a redirect can work is before that import - which means before any test
 * file imports the device. Doing it here is what keeps every test off the real
 * ~/.claude-server-commander/config.json, rather than each file remembering to.
 *
 * Not named test*.js, and in a subdirectory: run-all-tests.js scans the top of
 * test/ for files starting with "test", so a helper here is never run as one.
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
 * Stands in for the Supabase client. It owns a `currentSession` the way auth-js
 * does, so a rotation changes what getSession() reports - which is exactly what
 * savePersistedConfig() reads when it decides what to write.
 *
 * getSession() snapshots the session BEFORE its optional delay. That models the
 * real hazard: a save reads the session it is going to write, then takes time
 * to get it onto disk, during which a newer save can overtake it.
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

        /** How long the NEXT save should take to read its session, in order. */
        delaySaves(...msPerSave) {
            sessionDelays.push(...msPerSave);
        },

        /** auth-js drops the session: getSession() answers null from here on. */
        signOut() {
            currentSession = null;
        },

        /** What the 45-minute refresh does: rotate, then announce it. */
        rotate(access_token, refresh_token) {
            currentSession = { access_token, refresh_token };
            authListener?.('TOKEN_REFRESHED', currentSession);
        },
    };
}

/**
 * A device wired to a fake client and a throwaway config file, at the point
 * start() reaches once a session is in hand: listener registered, config
 * written once. `persist: false` leaves the config file absent instead.
 */
export async function makeDevice(configPath, { deviceId = DEVICE_ID, persist = true } = {}) {
    const device = new MCPDevice();
    device.deviceId = deviceId;
    device.configPath = configPath;

    const client = makeFakeClient();
    const rc = device.remoteChannel;
    rc.client = client; // private in TS, plain property at runtime

    // shutdown() walks the teardown path; none of it is under test here.
    rc.stopHeartbeat = () => { };
    rc.unsubscribe = async () => { };
    rc.setOffline = async () => { };
    device.desktop = { shutdown: async () => { }, listClientTools: async () => ({ tools: [] }) };

    // Registers the TOKEN_REFRESHED listener, as start() does.
    await rc.setSession({ access_token: 'access-1', refresh_token: 'refresh-1' });
    // start() persists exactly here, before the revocation check.
    if (persist) await device.savePersistedConfig();

    return { device, client };
}

/**
 * Drain the config write queue. Waiting on the queue itself is exact, where
 * polling for a file that should never appear can only ever time out. Private
 * in TS, a plain property at runtime, like rc.client above.
 */
export const drainWrites = (device) => device.configWriteChain;

export const readPersisted = (configPath) => JSON.parse(readFileSync(configPath, 'utf8'));

export const onDisk = (configPath) => {
    try {
        return readFileSync(configPath, 'utf8');
    } catch {
        return '<absent>';
    }
};

/**
 * Wait for the config to satisfy `predicate`, or give up. Polling rather than a
 * fixed sleep: a sleep only gives an async save time to finish, it never
 * confirms that it did, and on a loaded machine that reads the old token and
 * fails a correct implementation (raised in review on #710).
 */
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
 * Windows rename is intermittently EPERM under an antivirus or an indexer. A
 * write that failed leaves no file behind, which is indistinguishable from a
 * removal that held - so an unlucky run would read as a pass for the wrong
 * reason, or as a precondition failure that looks like the defect under test.
 *
 * Recorded and still printed. Swallowing the line would make this module a
 * silencer for anything that imports it, and not every importer runs the
 * assertion below - a child process cannot.
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
