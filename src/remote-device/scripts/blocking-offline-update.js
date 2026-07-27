#!/usr/bin/env node

/**
 * Blocking script to update device status to offline
 * Runs synchronously during shutdown to ensure DB update completes
 * 
 * Usage: SUPABASE_ACCESS_TOKEN=<token> SUPABASE_REFRESH_TOKEN=<token> node blocking-offline-update.js <deviceId> <supabaseUrl> <supabaseKey>
 * 
 * Note: Tokens are passed via environment variables (not command-line args)
 * to prevent exposure in process listings (ps aux, /proc/PID/cmdline).
 */

import { createClient } from '@supabase/supabase-js';

// Parse command line arguments (non-sensitive only)
const [deviceId, supabaseUrl, supabaseKey] = process.argv.slice(2);

// Read sensitive tokens from environment variables
const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
const refreshToken = process.env.SUPABASE_REFRESH_TOKEN;

if (!deviceId || !supabaseUrl || !supabaseKey || !accessToken || !refreshToken) {
    console.error('❌ Missing required arguments');
    console.error('Usage: SUPABASE_ACCESS_TOKEN=<token> SUPABASE_REFRESH_TOKEN=<token> node blocking-offline-update.js <deviceId> <supabaseUrl> <supabaseKey>');
    process.exit(1);
}

// Set timeout for entire operation
const TIMEOUT_MS = 3000;
const timeoutHandle = setTimeout(() => {
    console.error('⏱️ Timeout: Update took too long');
    process.exit(2); // Exit code 2 for timeout
}, TIMEOUT_MS);

try {
    // Create Supabase client
    const client = createClient(supabaseUrl, supabaseKey);

    // Set session using access token and refresh token
    const { error: authError } = await client.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken
    });

    if (authError) {
        console.error('❌ Auth error:', authError.message);
        clearTimeout(timeoutHandle);
        process.exit(3); // Exit code 3 for auth error
    }

    // Update device status to offline
    const { error } = await client
        .from('mcp_devices')
        .update({ status: 'offline' })
        .eq('id', deviceId);

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
