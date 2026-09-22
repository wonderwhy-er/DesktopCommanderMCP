/**
 * One process of an unattended restart, run as a real child process.
 *
 * The card behind #695 asks for one thing the in-process cases cannot answer:
 * after the token rotates and the service restarts, does the device come back
 * on its own, with nobody at a browser? A second `new MCPDevice()` in the same
 * process does not answer it - the interesting state is the file on disk and a
 * process that has forgotten everything else.
 *
 * So this is a whole `start()`, in its own process, against:
 *
 *   - a token ledger on disk, which is what makes rotation survive the restart.
 *     GoTrue refuses a refresh token it has already rotated away, and so does
 *     this: a spent token answers 'Invalid Refresh Token: Already Used', the
 *     error the reporters pasted.
 *   - DeviceAuthenticator.authenticate() replaced by a trap. It is constructed
 *     inside start() and cannot be injected, but ESM modules are singletons, so
 *     patching the prototype reaches the instance start() makes. Any run that
 *     reaches for a browser says so and fails, instead of quietly waiting out a
 *     fifteen-minute device code.
 *
 * Everything else that would touch the network is stubbed at the seam it sits
 * behind. The control flow of start() itself is the real one.
 *
 * Env:
 *   DC_CONFIG           device.json to use
 *   DC_LEDGER           the server's view of which tokens are live
 *   DC_ROTATE=1         rotate once the device is up, as the 45-minute refresh does
 *   DC_PERSIST_ROTATION=0   drop the rotation->disk wiring, i.e. 0.2.50
 *   DC_BREAK_WRITES     save to this path once up, to exercise a failed write
 *
 * Prints exactly one RESULT: line - READY, BROWSER_REQUIRED, or WRITE_FAILED
 * when a config write reported a failure, which makes an environment fault say
 * its own name instead of the behaviour under test. Not named test*.js: it is a fixture, and
 * run-all-tests.js only runs the top of test/.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { MCPDevice, persistenceFailures } from './remote-device-harness.js';

const { DeviceAuthenticator } = await import('../../dist/remote-device/device-authenticator.js');

const CONFIG = process.env.DC_CONFIG;
const LEDGER = process.env.DC_LEDGER;

const readLedger = () => JSON.parse(readFileSync(LEDGER, 'utf8'));
const writeLedger = (l) => writeFileSync(LEDGER, JSON.stringify(l, null, 2));

// The browser path, booby-trapped. Reaching it is the failure this scenario
// exists to detect, so it has to be loud rather than slow.
DeviceAuthenticator.prototype.authenticate = async function trapped() {
    console.log('RESULT: BROWSER_REQUIRED');
    process.exit(2);
};

/**
 * exp out of a JWT-shaped access token, or null for the plain strings the
 * other cases use. The issue measured the real ones this way: iat and exp an
 * hour apart, rotated at forty-five minutes.
 */
function expiryOf(token) {
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    try {
        return JSON.parse(Buffer.from(parts[1], 'base64url').toString()).exp ?? null;
    } catch {
        return null;
    }
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** The server's side of a session: one live pair, and the ones it has retired. */
function makeLedgerClient() {
    let authListener = null;

    const rotate = (ledger) => {
        ledger.spent.push(ledger.current.refresh);
        const n = ledger.spent.length + 1;
        ledger.current = { access: `access-${n}`, refresh: `refresh-${n}` };
        writeLedger(ledger);
        return ledger;
    };

    const live = () => {
        const { current } = readLedger();
        return { access_token: current.access, refresh_token: current.refresh };
    };

    return {
        auth: {
            setSession: async ({ access_token, refresh_token }) => {
                const ledger = readLedger();
                if (ledger.spent.includes(refresh_token)) {
                    return {
                        data: { user: null },
                        error: { message: 'Invalid Refresh Token: Already Used' },
                    };
                }
                if (refresh_token !== ledger.current.refresh) {
                    return { data: { user: null }, error: { message: 'Invalid Refresh Token' } };
                }
                // GoTrue does not hand back an expired access token: it spends
                // the refresh token for a new pair. So a restart past the hour
                // rotates before it is even up, and that rotation has to reach
                // disk like any other or the NEXT restart replays a spent one.
                const exp = expiryOf(access_token);
                if (exp !== null && exp <= nowSeconds()) rotate(ledger);
                return {
                    data: { user: { id: 'user-1', email: 'tester@example.com' } },
                    error: null,
                };
            },
            getSession: async () => ({ data: { session: live() }, error: null }),
            onAuthStateChange: (cb) => {
                authListener = cb;
                return { data: { subscription: { unsubscribe() { } } } };
            },
        },
        realtime: { setAuth: () => { } },

        /** What the 45-minute refresh does: retire the old pair, announce the new. */
        rotate() {
            const ledger = rotate(readLedger());
            authListener?.('TOKEN_REFRESHED', {
                access_token: ledger.current.access,
                refresh_token: ledger.current.refresh,
            });
        },
    };
}

const device = new MCPDevice();
device.configPath = CONFIG;

const client = makeLedgerClient();
const rc = device.remoteChannel;

// Seams that would otherwise reach the network, each stubbed where it sits.
device.fetchSupabaseConfig = async () => ({ supabaseUrl: 'https://fake.invalid', anonKey: 'anon' });
rc.initialize = () => { rc.client = client; };
rc.findDevice = async (id) => ({ id });
rc.updateDevice = async () => ({});
rc.registerDevice = async (_caps, id) => { rc.deviceId = id; };
rc.startHeartbeat = () => { };
rc.stopHeartbeat = () => { };
rc.unsubscribe = async () => { };
rc.setOffline = async () => { };
device.desktop = {
    ready: true,
    initialize: async () => { },
    onDisconnect: () => { },
    listClientTools: async () => ({ tools: [] }),
    shutdown: async () => { },
};

if (process.env.DC_PERSIST_ROTATION === '0') {
    // 0.2.50: TOKEN_REFRESHED updated memory and nothing else.
    rc.onSessionRefreshed(() => { });
}

await device.start();

if (process.env.DC_BREAK_WRITES) {
    // A save that cannot land, after the device is already up: the path names a
    // directory that is really a file, so mkdir fails on every platform without
    // permissions having to be arranged.
    device.configPath = process.env.DC_BREAK_WRITES;
    await device.savePersistedConfig();
}

if (process.env.DC_ROTATE === '1') {
    client.rotate();
    await device.configWriteQueue; // let the rotation reach disk, if it is going to
}

// A config write that failed leaves the same empty directory as one that was
// never attempted, so a run that hit one proves nothing about restarting. Say
// so rather than letting the environment masquerade as the behaviour under
// test - EPERM on rename is intermittent on Windows.
const failures = persistenceFailures();
if (failures.length) {
    console.log(`WRITE-FAILURE: ${failures.join('; ')}`);
    console.log('RESULT: WRITE_FAILED');
    await device.shutdown();
    process.exit(3);
}

console.log('RESULT: READY');
await device.shutdown();
process.exit(0);
