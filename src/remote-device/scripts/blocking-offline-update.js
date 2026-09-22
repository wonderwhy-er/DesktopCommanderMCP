#!/usr/bin/env node

/**
 * Blocking script to update device status to offline
 * Runs synchronously during shutdown to ensure DB update completes
 * 
 * Usage: node blocking-offline-update.js <deviceId> <supabaseUrl> <supabaseKey> <accessToken> [refreshToken]
 * Without a refreshToken only a still-valid accessToken can be used.
 */

import { createClient } from '@supabase/supabase-js';

// Parse command line arguments
const [deviceId, supabaseUrl, supabaseKey, accessToken, refreshToken] = process.argv.slice(2);

if (!deviceId || !supabaseUrl || !supabaseKey || !accessToken) {
    console.error('❌ Missing required arguments');
    console.error('Usage: node blocking-offline-update.js <deviceId> <supabaseUrl> <supabaseKey> <accessToken> [refreshToken]');
    process.exit(1);
}

// Set timeout for entire operation
const TIMEOUT_MS = 3000;
const timeoutHandle = setTimeout(() => {
    console.error('⏱️ Timeout: Update took too long');
    process.exit(2); // Exit code 2 for timeout
}, TIMEOUT_MS);

const auth = { persistSession: false, autoRefreshToken: false };

// Update device status to offline, stamping the exact shutdown moment so
// "last seen X ago" is precise for clean shutdowns (the periodic
// bookkeeping write only runs on the slow capable cadence).
// The token goes straight to PostgREST as a Bearer header: setSession()
// would first spend a GoTrue round trip of the budget re-validating it.
const markOffline = (token) => createClient(supabaseUrl, supabaseKey, {
    auth,
    global: { headers: { Authorization: `Bearer ${token}` } }
})
    .from('mcp_devices')
    .update({ status: 'offline', last_seen: new Date().toISOString() })
    .eq('id', deviceId);

function tokenLooksLive(token) {
    try {
        const { exp } = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
        return typeof exp === 'number' && exp * 1000 > Date.now() + 5000;
    } catch {
        return false;
    }
}

// refreshSession(), not setSession(): setSession() validates a token that
// looks live on this machine's clock via /user instead of refreshing it.
async function refreshedToken() {
    if (!refreshToken) {
        console.error('❌ Auth error: access token not usable and no refresh token');
        clearTimeout(timeoutHandle);
        process.exit(3); // Exit code 3 for auth error
    }
    const client = createClient(supabaseUrl, supabaseKey, { auth });
    const { data, error: authError } = await client.auth.refreshSession({ refresh_token: refreshToken });

    if (authError || !data.session) {
        console.error('❌ Auth error:', authError?.message ?? 'no session returned');
        clearTimeout(timeoutHandle);
        process.exit(3); // Exit code 3 for auth error
    }
    return data.session.access_token;
}

try {
    // An expired token (e.g. the machine just woke) is refreshed first. A 401
    // means it only looked live on this machine's clock: refresh and retry once.
    let result = tokenLooksLive(accessToken) ? await markOffline(accessToken) : null;
    if (!result || result.status === 401) {
        result = await markOffline(await refreshedToken());
    }

    const { error } = result;

    clearTimeout(timeoutHandle);

    if (error) {
        console.error('❌ DB update error:', error.message);
        process.exit(4); // Exit code 4 for DB error
    }

    console.log('✓ Device marked as offline');
    process.exit(0); // Success

} catch (error) {
    clearTimeout(timeoutHandle);
    console.error('❌ Unexpected error:', error.message);
    process.exit(5); // Exit code 5 for unexpected error
}
