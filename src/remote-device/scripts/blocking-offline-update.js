#!/usr/bin/env node

/**
 * Blocking script to update device status to offline
 * Runs synchronously during shutdown to ensure DB update completes
 * 
 * Usage: node blocking-offline-update.js <deviceId> <supabaseUrl> <supabaseKey> <accessToken> <refreshToken>
 */

import { createClient } from '@supabase/supabase-js';

// Parse command line arguments
const [deviceId, supabaseUrl, supabaseKey, accessToken, refreshToken] = process.argv.slice(2);

if (!deviceId || !supabaseUrl || !supabaseKey || !accessToken || !refreshToken) {
    console.error('❌ Missing required arguments');
    console.error('Usage: node blocking-offline-update.js <deviceId> <supabaseUrl> <supabaseKey> <accessToken> <refreshToken>');
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
const markOffline = (client) => client
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

async function refreshedClient() {
    const client = createClient(supabaseUrl, supabaseKey, { auth });
    const { error: authError } = await client.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken
    });

    if (authError) {
        console.error('❌ Auth error:', authError.message);
        clearTimeout(timeoutHandle);
        process.exit(3); // Exit code 3 for auth error
    }
    return client;
}

try {
    // A live token goes straight to PostgREST as a Bearer header: setSession()
    // would first spend a GoTrue round trip of the budget re-validating it.
    // An expired one (e.g. the machine just woke) is refreshed via setSession().
    const client = tokenLooksLive(accessToken)
        ? createClient(supabaseUrl, supabaseKey, {
            auth,
            global: { headers: { Authorization: `Bearer ${accessToken}` } }
        })
        : await refreshedClient();

    const { error } = await markOffline(client);

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
