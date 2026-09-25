#!/usr/bin/env node

/**
 * Blocking script to update device status to offline
 * Runs synchronously during shutdown to ensure DB update completes
 *
 * Usage: node blocking-offline-update.js <deviceId> <supabaseUrl> <supabaseKey> <accessToken> [refreshToken]
 * Without a refreshToken only a still-valid accessToken can be used.
 *
 * Ends through exitProcess(), never process.exit(): process.exit() right after
 * the update's fetch() can abort Node on Windows with exit code 0xC0000409
 * (see src/utils/exit-process.ts), and the parent then reports a failed update.
 */

import { createClient } from '@supabase/supabase-js';

// The build copies this script to dist/remote-device/scripts/, next to the
// compiled dist/utils/exit-process.js. Run from a source checkout (npm run
// device:start starts it with plain node, without tsx) it loads the checkout's
// build, dist/utils/exit-process.js (npm install builds it), which works on
// every Node version. Without a build it falls back to
// src/utils/exit-process.ts, which only Node 22.18+ loads (by stripping types).
const ifNotFound = (importNext) => (error) => {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return importNext();
};
const { exitProcess, EXIT_GRACE_MS } = await import('../../utils/exit-process.js')
    .catch(ifNotFound(() => import('../../../dist/utils/exit-process.js')))
    .catch(ifNotFound(() => import('../../utils/exit-process.ts')));

// Parse command line arguments
const [deviceId, supabaseUrl, supabaseKey, accessToken, refreshToken] = process.argv.slice(2);

if (!deviceId || !supabaseUrl || !supabaseKey || !accessToken) {
    console.error('❌ Missing required arguments');
    console.error('Usage: node blocking-offline-update.js <deviceId> <supabaseUrl> <supabaseKey> <accessToken> [refreshToken]');
    exitProcess(1);
} else {
    await markDeviceOffline();
}

async function markDeviceOffline() {
    // The parent (setOffline() in remote-channel.ts) kills this script 3000ms
    // after starting it. The update gets that time, counted from the start of
    // the process, minus what the process may need to end once it gives up.
    const PARENT_TIMEOUT_MS = 3000;
    const deadline = new AbortController();
    const timeoutHandle = setTimeout(() => {
        console.error('⏱️ Timeout: Update took too long');
        exitProcess(2); // Exit code 2 for timeout
        // Ends the requests still in flight, which would keep the process alive
        deadline.abort();
    }, PARENT_TIMEOUT_MS - EXIT_GRACE_MS - performance.now());

    const auth = { persistSession: false, autoRefreshToken: false };
    const fetchBeforeDeadline = (input, init) => fetch(input, { ...init, signal: deadline.signal });

    // Update device status to offline, stamping the exact shutdown moment so
    // "last seen X ago" is precise for clean shutdowns (the periodic
    // bookkeeping write only runs on the slow capable cadence).
    // The token goes straight to PostgREST as a Bearer header: setSession()
    // would first spend a GoTrue round trip of the budget re-validating it.
    const markOffline = (token) => createClient(supabaseUrl, supabaseKey, {
        auth,
        global: { headers: { Authorization: `Bearer ${token}` }, fetch: fetchBeforeDeadline }
    })
        .from('mcp_devices')
        .update({ status: 'offline', last_seen: new Date().toISOString() })
        .eq('id', deviceId);

    function tokenLooksLive(token) {
        try {
            const { exp } = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
            return typeof exp === 'number' && exp * 1000 > Date.now() + 5000;
        } catch {
            // Not a JWT we can read: treat it as expired and refresh the session
            return false;
        }
    }

    // refreshSession(), not setSession(): setSession() validates a token that
    // looks live on this machine's clock via /user instead of refreshing it.
    // Resolves with the new access token, or undefined after reporting why there is none.
    async function refreshedToken() {
        if (!refreshToken) {
            console.error('❌ Auth error: access token not usable and no refresh token');
            return undefined;
        }
        const client = createClient(supabaseUrl, supabaseKey, { auth, global: { fetch: fetchBeforeDeadline } });
        const { data, error: authError } = await client.auth.refreshSession({ refresh_token: refreshToken });

        if (authError || !data.session) {
            console.error('❌ Auth error:', authError?.message ?? 'no session returned');
            return undefined;
        }
        return data.session.access_token;
    }

    // Resolves with the exit code
    async function update() {
        try {
            // An expired token (e.g. the machine just woke) is refreshed first. A 401
            // means it only looked live on this machine's clock: refresh and retry once.
            let result = tokenLooksLive(accessToken) ? await markOffline(accessToken) : null;
            if (!result || result.status === 401) {
                const token = await refreshedToken();
                if (!token) {
                    return 3; // Exit code 3 for auth error
                }
                result = await markOffline(token);
            }

            const { error } = result;

            if (error) {
                console.error('❌ DB update error:', error.message);
                return 4; // Exit code 4 for DB error
            }

            console.log('✓ Device marked as offline');
            return 0; // Success

        } catch (error) {
            console.error('❌ Unexpected error:', error.message);
            return 5; // Exit code 5 for unexpected error
        }
    }

    const code = await update();
    clearTimeout(timeoutHandle);
    // After a timeout the exit code stays 2 (only exitProcess()'s first call counts)
    exitProcess(code);
}
