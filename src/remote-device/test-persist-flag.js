#!/usr/bin/env node

// Quick test to verify --persist-session flag parsing

const args = process.argv.slice(2);
const options = {
    persistSession: args.includes('--persist-session')
};

console.log('Command-line arguments:', args);
console.log('Options parsed:', options);

if (options.persistSession) {
    console.log('✅ Session persistence is ENABLED');
} else {
    console.log('❌ Session persistence is DISABLED (use --persist-session to enable)');
}

// Simulate save behavior
const simulateSave = (session, persistSession) => {
    const config = {
        deviceId: 'test-device-123',
        session: (session && persistSession) ? {
            access_token: session.access_token,
            refresh_token: session.refresh_token
        } : null
    };
    return config;
};

const testSession = {
    access_token: 'test_access_token',
    refresh_token: 'test_refresh_token'
};

console.log('\nConfig that would be saved:');
console.log(JSON.stringify(simulateSave(testSession, options.persistSession), null, 2));
