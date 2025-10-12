#!/usr/bin/env node

// Test script for read-only directory protection

import { configManager } from './dist/config-manager.js';
import { writeFile } from './dist/tools/filesystem.js';

async function testReadOnlyProtection() {
    console.log('Testing read-only directory protection...\n');
    
    // Set up a read-only directory within allowed paths
    await configManager.init();
    await configManager.setValue('readOnlyDirectories', ['/home/konverts/projects2/test-readonly']);
    
    console.log('✅ Configuration set: /home/konverts/projects2/test-readonly is now read-only\n');
    
    // Try to write to a read-only directory
    try {
        console.log('Attempting to write to /home/konverts/projects2/test-readonly/test.txt...');
        await writeFile('/home/konverts/projects2/test-readonly/test.txt', 'This should fail');
        console.log('❌ ERROR: Write succeeded when it should have failed!');
    } catch (error) {
        console.log('✅ Write correctly blocked:', error.message);
    }
    
    // Try to write to a non-protected directory
    try {
        console.log('\nAttempting to write to /home/konverts/projects2/test-allowed/test.txt...');
        await writeFile('/home/konverts/projects2/test-allowed/test.txt', 'This should work');
        console.log('✅ Write succeeded to non-protected directory');
    } catch (error) {
        console.log('❌ ERROR: Write failed:', error.message);
    }
    
    console.log('\n✅ Read-only protection test complete!');
}

testReadOnlyProtection().catch(console.error);
