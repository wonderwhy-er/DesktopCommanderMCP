/**
 * One whole start(), in its own process, driven by env (DC_CONFIG, DC_LEDGER,
 * DC_ROTATE, DC_PERSIST_ROTATION, DC_BREAK_WRITES) and answering with one
 * RESULT line. The ledger on disk is the server's: a refresh token it has
 * rotated away answers 'Invalid Refresh Token: Already Used', as GoTrue does.
 * Kept out of test/*.js so run-all-tests.js never runs it as a test.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { MCPDevice, persistenceFailures } from './remote-device-harness.js';

const { DeviceAuthenticator } = await import('../../dist/remote-device/device-authenticator.js');

const CONFIG = process.env.DC_CONFIG;
const LEDGER = process.env.DC_LEDGER;

const readLedger = () => JSON.parse(readFileSync(LEDGER, 'utf8'));
const writeLedger = (l) => writeFileSync(LEDGER, JSON.stringify(l, null, 2));

// Constructed inside start() and not injectable, but ESM modules are
// singletons, so the prototype reaches the instance start() makes.
DeviceAuthenticator.prototype.authenticate = async function trapped() {
    console.log('RESULT: BROWSER_REQUIRED');
    process.exit(2);
};

/** The issue read the real timings here: iat and exp an hour apart. */
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
                // GoTrue spends the refresh token rather than hand back an
                // expired access token, so a restart past the hour rotates
                // before it is even up.
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
    // The path names a directory that is really a file: mkdir fails on every
    // platform, with no permissions to arrange.
    device.configPath = process.env.DC_BREAK_WRITES;
    await device.savePersistedConfig();
}

if (process.env.DC_ROTATE === '1') {
    client.rotate();
    await device.configWriteQueue; // let the rotation reach disk, if it is going to
}

// Without this an EPERM on rename - intermittent on Windows - reads as a
// verdict about restarting.
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
