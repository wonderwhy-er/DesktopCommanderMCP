#!/usr/bin/env node

// Test script to measure timeout behavior
import { spawn } from 'child_process';

async function testTimeoutBehavior() {
    console.log('=== Testing Timeout Behavior ===\n');
    
    // Test 1: Fast command with long timeout
    console.log('Test 1: Fast command (5s) with long timeout (10s)');
    const startTime1 = Date.now();
    
    const result1 = await new Promise((resolve) => {
        const process = spawn('sh', ['-c', 'echo "Starting..." && sleep 5 && echo "Done!"']);
        let output = '';
        let resolved = false;
        
        process.stdout.on('data', (data) => {
            output += data.toString();
        });
        
        // Timeout after 10 seconds
        const timeout = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                resolve({ output, reason: 'timeout', time: Date.now() - startTime1 });
            }
        }, 10000);
        
        // Process exit
        process.on('exit', () => {
            if (!resolved) {
                resolved = true;
                clearTimeout(timeout);
                resolve({ output, reason: 'process_exit', time: Date.now() - startTime1 });
            }
        });
    });
    
    console.log(`Result: ${result1.reason} after ${result1.time}ms`);
    console.log(`Output: ${result1.output.trim()}\n`);
    
    // Test 2: Slow command with short timeout
    console.log('Test 2: Slow command (10s) with short timeout (5s)');
    const startTime2 = Date.now();
    
    const result2 = await new Promise((resolve) => {
        const process = spawn('sh', ['-c', 'echo "Starting slow command..." && sleep 10 && echo "Finally done!"']);
        let output = '';
        let resolved = false;
        
        process.stdout.on('data', (data) => {
            output += data.toString();
        });
        
        // Timeout after 5 seconds
        const timeout = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                process.kill(); // Kill the slow process
                resolve({ output, reason: 'timeout', time: Date.now() - startTime2 });
            }
        }, 5000);
        
        // Process exit
        process.on('exit', () => {
            if (!resolved) {
                resolved = true;
                clearTimeout(timeout);
                resolve({ output, reason: 'process_exit', time: Date.now() - startTime2 });
            }
        });
    });
    
    console.log(`Result: ${result2.reason} after ${result2.time}ms`);
    console.log(`Output: ${result2.output.trim()}\n`);
    
    // Test 3: Using the TerminalManager approach
    console.log('Test 3: Simulating TerminalManager logic');
    const startTime3 = Date.now();
    
    const result3 = await new Promise((resolve) => {
        const process = spawn('sh', ['-c', 'echo "Testing TerminalManager approach..." && sleep 3 && echo "Process done!"']);
        let output = '';
        let isBlocked = false;
        
        process.stdout.on('data', (data) => {
            output += data.toString();
        });
        
        // This simulates the TerminalManager timeout behavior
        setTimeout(() => {
            isBlocked = true;
            resolve({
                output,
                isBlocked: true,
                reason: 'timeout_reached',
                time: Date.now() - startTime3
            });
        }, 8000); // 8 second timeout
        
        process.on('exit', (code) => {
            if (!isBlocked) {
                resolve({
                    output,
                    isBlocked: false,
                    reason: 'process_exit',
                    time: Date.now() - startTime3,
                    exitCode: code
                });
            }
        });
    });
    
    console.log(`Result: ${result3.reason} after ${result3.time}ms`);
    console.log(`Output: ${result3.output.trim()}`);
    console.log(`Is Blocked: ${result3.isBlocked}`);
    if (result3.exitCode !== undefined) {
        console.log(`Exit Code: ${result3.exitCode}`);
    }
}

testTimeoutBehavior().catch(console.error);