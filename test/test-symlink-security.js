/**
 * Test script for symlink security in validatePath
 * 
 * This script tests that symlinks cannot be used to bypass allowedDirectories restrictions.
 * The attack scenario:
 * 1. User configures allowedDirectories to ["/allowed"]
 * 2. Attacker creates symlink: /allowed/evil → /etc/passwd (or other restricted path)
 * 3. validatePath should detect this and block access
 */

import { configManager } from '../dist/config-manager.js';
import { validatePath } from '../dist/tools/filesystem.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test directories
const ALLOWED_DIR = path.join(__dirname, 'test_symlink_allowed');
const RESTRICTED_DIR = path.join(__dirname, 'test_symlink_restricted');
const SYMLINK_TO_RESTRICTED = path.join(ALLOWED_DIR, 'link_to_restricted');
const SYMLINK_TO_RESTRICTED_FILE = path.join(ALLOWED_DIR, 'link_to_secret');

/**
 * Clean up test directories
 */
async function cleanup() {
    console.log('Cleaning up test directories...');
    await fs.rm(ALLOWED_DIR, { recursive: true, force: true }).catch(() => {});
    await fs.rm(RESTRICTED_DIR, { recursive: true, force: true }).catch(() => {});
}

/**
 * Setup test environment
 */
async function setup() {
    await cleanup();
    
    // Create directories
    await fs.mkdir(ALLOWED_DIR, { recursive: true });
    await fs.mkdir(RESTRICTED_DIR, { recursive: true });
    
    // Create a file in the restricted directory (simulates /etc/passwd or ~/.ssh/id_rsa)
    await fs.writeFile(path.join(RESTRICTED_DIR, 'secret.txt'), 'TOP SECRET DATA');
    
    // Create a normal file in the allowed directory
    await fs.writeFile(path.join(ALLOWED_DIR, 'normal.txt'), 'Normal allowed content');
    
    // Create symlinks pointing to restricted locations
    // Symlink to restricted directory
    await fs.symlink(RESTRICTED_DIR, SYMLINK_TO_RESTRICTED);
    // Symlink to specific restricted file
    await fs.symlink(path.join(RESTRICTED_DIR, 'secret.txt'), SYMLINK_TO_RESTRICTED_FILE);
    
    console.log('✓ Setup complete');
    console.log(`  Allowed dir: ${ALLOWED_DIR}`);
    console.log(`  Restricted dir: ${RESTRICTED_DIR}`);
    console.log(`  Symlink (dir): ${SYMLINK_TO_RESTRICTED} → ${RESTRICTED_DIR}`);
    console.log(`  Symlink (file): ${SYMLINK_TO_RESTRICTED_FILE} → ${RESTRICTED_DIR}/secret.txt`);
    
    // Save original config
    return await configManager.getConfig();
}

/**
 * Test helper: check if path validation succeeds or fails
 */
async function canAccessPath(testPath) {
    try {
        const result = await validatePath(testPath);
        console.log(`  ✓ validatePath("${testPath}") → "${result}"`);
        return { success: true, result };
    } catch (error) {
        console.log(`  ✗ validatePath("${testPath}") → Error: ${error.message}`);
        return { success: false, error: error.message };
    }
}


/**
 * Test 1: Normal file access within allowed directory (should succeed)
 */
async function testNormalFileAccess() {
    console.log('\n--- Test 1: Normal file access within allowed directory ---');
    
    await configManager.setValue('allowedDirectories', [ALLOWED_DIR]);
    
    const normalFile = path.join(ALLOWED_DIR, 'normal.txt');
    const result = await canAccessPath(normalFile);
    
    assert.strictEqual(result.success, true, 'Normal file in allowed directory should be accessible');
    console.log('✓ Test 1 passed: Normal files are accessible');
}

/**
 * Test 2: Direct access to restricted directory (should fail)
 */
async function testDirectRestrictedAccess() {
    console.log('\n--- Test 2: Direct access to restricted directory ---');
    
    await configManager.setValue('allowedDirectories', [ALLOWED_DIR]);
    
    const result = await canAccessPath(RESTRICTED_DIR);
    
    assert.strictEqual(result.success, false, 'Direct access to restricted directory should fail');
    console.log('✓ Test 2 passed: Direct restricted access is blocked');
}

/**
 * Test 3: SYMLINK BYPASS - Directory symlink pointing outside allowed dirs
 * This is the main security test!
 */
async function testSymlinkDirectoryBypass() {
    console.log('\n--- Test 3: SYMLINK BYPASS - Directory symlink pointing outside ---');
    console.log('  Attack scenario: symlink inside allowed dir points to restricted dir');
    
    await configManager.setValue('allowedDirectories', [ALLOWED_DIR]);
    
    // The symlink path LOOKS like it's in ALLOWED_DIR
    // But it actually points to RESTRICTED_DIR
    const result = await canAccessPath(SYMLINK_TO_RESTRICTED);
    
    assert.strictEqual(result.success, false, 
        'SECURITY: Symlink pointing to restricted directory should be BLOCKED');
    console.log('✓ Test 3 passed: Symlink directory bypass is blocked');
}

/**
 * Test 4: SYMLINK BYPASS - File symlink pointing outside allowed dirs
 */
async function testSymlinkFileBypass() {
    console.log('\n--- Test 4: SYMLINK BYPASS - File symlink pointing outside ---');
    console.log('  Attack scenario: symlink inside allowed dir points to restricted file');
    
    await configManager.setValue('allowedDirectories', [ALLOWED_DIR]);
    
    const result = await canAccessPath(SYMLINK_TO_RESTRICTED_FILE);
    
    assert.strictEqual(result.success, false, 
        'SECURITY: Symlink pointing to restricted file should be BLOCKED');
    console.log('✓ Test 4 passed: Symlink file bypass is blocked');
}

/**
 * Test 5: Access file through directory symlink
 * Attempt to access a file via the symlinked directory
 */
async function testAccessThroughSymlinkDir() {
    console.log('\n--- Test 5: Access file through directory symlink ---');
    
    await configManager.setValue('allowedDirectories', [ALLOWED_DIR]);
    
    // Try to access a file through the symlinked directory
    // This path: /allowed/link_to_restricted/secret.txt
    // Would resolve to: /restricted/secret.txt
    const throughSymlinkPath = path.join(SYMLINK_TO_RESTRICTED, 'secret.txt');
    console.log(`  Path through symlink: ${throughSymlinkPath}`);
    
    const result = await canAccessPath(throughSymlinkPath);
    
    // This should fail because even though the path looks like it's in allowed dir,
    // the resolved real path is in the restricted dir
    assert.strictEqual(result.success, false, 
        'SECURITY: Accessing file through symlinked directory should be BLOCKED');
    console.log('✓ Test 5 passed: Access through symlink dir is blocked');
}


/**
 * Test 6: Symlink within allowed directory pointing to another allowed location (should succeed)
 */
async function testSymlinkWithinAllowed() {
    console.log('\n--- Test 6: Symlink within allowed directories ---');
    
    // Create another allowed subdirectory and symlink within it
    const subdir = path.join(ALLOWED_DIR, 'subdir');
    await fs.mkdir(subdir, { recursive: true });
    await fs.writeFile(path.join(subdir, 'allowed_secret.txt'), 'Allowed secret');
    
    const internalSymlink = path.join(ALLOWED_DIR, 'link_to_subdir');
    await fs.symlink(subdir, internalSymlink).catch(() => {});
    
    await configManager.setValue('allowedDirectories', [ALLOWED_DIR]);
    
    const result = await canAccessPath(internalSymlink);
    
    // This SHOULD succeed because the resolved path is still within allowed dirs
    assert.strictEqual(result.success, true, 
        'Symlink pointing within allowed directories should be accessible');
    console.log('✓ Test 6 passed: Internal symlinks work correctly');
}

/**
 * Test 7: Broken symlink (pointing to non-existent target)
 */
async function testBrokenSymlink() {
    console.log('\n--- Test 7: Broken symlink ---');
    
    const brokenSymlink = path.join(ALLOWED_DIR, 'broken_link');
    await fs.symlink('/nonexistent/path/that/does/not/exist', brokenSymlink).catch(() => {});
    
    await configManager.setValue('allowedDirectories', [ALLOWED_DIR]);
    
    const result = await canAccessPath(brokenSymlink);
    
    // Broken symlinks should be handled gracefully - the behavior depends on implementation
    // Current PR falls back to original path for ENOENT
    console.log(`  Broken symlink result: success=${result.success}`);
    console.log('✓ Test 7 passed: Broken symlinks handled gracefully');
}

/**
 * Main test runner
 */
async function runAllTests() {
    console.log('=== Symlink Security Tests ===');
    console.log('Testing that symlinks cannot bypass allowedDirectories restrictions\n');
    
    let originalConfig;
    let passed = 0;
    let failed = 0;
    
    try {
        originalConfig = await setup();
        
        // Run tests
        const tests = [
            testNormalFileAccess,
            testDirectRestrictedAccess,
            testSymlinkDirectoryBypass,
            testSymlinkFileBypass,
            testAccessThroughSymlinkDir,
            testSymlinkWithinAllowed,
            testBrokenSymlink,
        ];
        
        for (const test of tests) {
            try {
                await test();
                passed++;
            } catch (error) {
                console.error(`\n❌ ${test.name} FAILED:`, error.message);
                failed++;
            }
        }
        
    } finally {
        // Restore config
        if (originalConfig) {
            await configManager.updateConfig(originalConfig);
        }
        await cleanup();
    }
    
    console.log('\n' + '='.repeat(50));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    
    if (failed > 0) {
        console.log('\n⚠️  SECURITY TESTS FAILED - symlink bypass may be possible!');
        process.exit(1);
    } else {
        console.log('\n✅ All symlink security tests passed!');
    }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    runAllTests().catch(error => {
        console.error('❌ Unhandled error:', error);
        process.exit(1);
    });
}

export default runAllTests;
