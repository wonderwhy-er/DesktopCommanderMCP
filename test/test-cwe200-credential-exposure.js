/**
 * PoC test for CWE-200: Device credentials exposed via process.argv
 *
 * This test verifies that the blocking-offline-update.js script does NOT
 * receive sensitive tokens (access_token, refresh_token) via command-line
 * arguments (which are visible to all users via `ps aux`).
 *
 * Instead, tokens should be passed via environment variables or stdin.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to the files under test - go up one level from test/ to get repo root
const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'src/remote-device/scripts/blocking-offline-update.js');
const CHANNEL_PATH = path.join(REPO_ROOT, 'src/remote-device/remote-channel.ts');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (err) {
        console.log(`  ❌ ${name}`);
        console.log(`     ${err.message}`);
        failed++;
    }
}

console.log('Testing CWE-200: Credential exposure via process.argv\n');

// Test 1: blocking-offline-update.js should NOT read tokens from process.argv
test('blocking-offline-update.js should not read access_token/refresh_token from process.argv', () => {
    const content = readFileSync(SCRIPT_PATH, 'utf-8');
    const lines = content.split('\n');

    // Check every line that references process.argv — none should destructure token variables
    for (const line of lines) {
        if (line.includes('process.argv')) {
            assert.ok(
                !/accessToken|refreshToken|access_token|refresh_token/i.test(line),
                `Line reads tokens from process.argv: ${line.trim()}`
            );
        }
    }
});

// Test 2: blocking-offline-update.js should read tokens from environment variables
test('blocking-offline-update.js should read tokens from environment variables', () => {
    const content = readFileSync(SCRIPT_PATH, 'utf-8');

    const envAccessToken = /process\.env\.\w*(?:ACCESS_TOKEN|access_token)/i.test(content);
    const envRefreshToken = /process\.env\.\w*(?:REFRESH_TOKEN|refresh_token)/i.test(content);

    assert.ok(
        envAccessToken && envRefreshToken,
        'Script should read access_token and refresh_token from process.env'
    );
});

// Test 3: remote-channel.ts should pass tokens via env, not as args
test('remote-channel.ts should pass tokens via env option in spawnSync, not as args', () => {
    const content = readFileSync(CHANNEL_PATH, 'utf-8');

    // Find the spawnSync call
    const spawnSyncIdx = content.indexOf('spawnSync');
    assert.ok(spawnSyncIdx !== -1, 'spawnSync call not found in remote-channel.ts');

    // Extract the args array between spawnSync('node', [ ... ])
    const afterSpawn = content.substring(spawnSyncIdx);
    const argsArrayMatch = afterSpawn.match(/spawnSync\(\s*'node'\s*,\s*\[([\s\S]*?)\]\s*,/);
    assert.ok(argsArrayMatch, 'Could not parse spawnSync args array');

    const argsContent = argsArrayMatch[1];
    // The args array should NOT contain access_token or refresh_token
    assert.ok(
        !argsContent.includes('access_token') && !argsContent.includes('refresh_token'),
        `Tokens should not be in command args: ${argsContent.trim()}`
    );

    // The options object should include env with the tokens
    const optionsMatch = afterSpawn.match(/spawnSync\(\s*'node'\s*,\s*\[[\s\S]*?\]\s*,\s*\{([\s\S]*?)\}\s*\)/);
    assert.ok(optionsMatch, 'Could not parse spawnSync options');

    const optionsContent = optionsMatch[1];
    assert.ok(
        optionsContent.includes('SUPABASE_ACCESS_TOKEN') || optionsContent.includes('access_token'),
        'spawnSync options should include env with access token'
    );
    assert.ok(
        optionsContent.includes('SUPABASE_REFRESH_TOKEN') || optionsContent.includes('refresh_token'),
        'spawnSync options should include env with refresh token'
    );
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
