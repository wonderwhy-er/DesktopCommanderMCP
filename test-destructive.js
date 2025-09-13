#!/usr/bin/env node

// Test script for destructive command safety rails

import { TerminalManager } from './dist/terminal-manager.js';
import { configManager } from './dist/config-manager.js';

async function testDestructiveCommandProtection() {
    console.log('Testing destructive command safety rails...\n');
    
    const manager = new TerminalManager();
    
    // Enable protection (it's enabled by default)
    await configManager.init();
    await configManager.setValue('requireExplicitPermission', true);
    
    console.log('✅ Protection enabled\n');
    
    // Test 1: Try rm -rf without permission flag
    console.log('Test 1: rm -rf without permission flag');
    const result1 = await manager.executeCommand('rm -rf /tmp/test-dir', 1000);
    if (result1.output.includes('DESTRUCTIVE OPERATION BLOCKED')) {
        console.log('✅ Command correctly blocked\n');
    } else {
        console.log('❌ ERROR: Command was not blocked!\n');
    }
    
    // Test 2: Try rm -rf WITH permission flag
    console.log('Test 2: rm -rf WITH permission flag');
    const result2 = await manager.executeCommand('rm --i-have-explicit-permission-from-user -rf /tmp/test-dir', 1000);
    if (!result2.output.includes('DESTRUCTIVE OPERATION BLOCKED')) {
        console.log('✅ Command allowed with permission flag\n');
    } else {
        console.log('❌ ERROR: Command was blocked even with flag!\n');
    }
    
    // Test 3: Try find with -delete
    console.log('Test 3: find with -delete');
    const result3 = await manager.executeCommand('find /tmp -name "*.log" -delete', 1000);
    if (result3.output.includes('DESTRUCTIVE OPERATION BLOCKED')) {
        console.log('✅ find -delete correctly blocked\n');
    } else {
        console.log('❌ ERROR: find -delete was not blocked!\n');
    }
    
    // Test 4: Normal commands should work
    console.log('Test 4: Normal command (ls)');
    const result4 = await manager.executeCommand('ls /tmp', 1000);
    if (!result4.output.includes('DESTRUCTIVE OPERATION BLOCKED')) {
        console.log('✅ Normal command allowed\n');
    } else {
        console.log('❌ ERROR: Normal command was blocked!\n');
    }
    
    console.log('✅ Destructive command protection test complete!');
    
    // Clean up
    manager.forceTerminate();
}

testDestructiveCommandProtection().catch(console.error);
