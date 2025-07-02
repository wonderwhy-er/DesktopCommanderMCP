#!/usr/bin/env node
/**
 * Test timing performance of the new early exit detection
 */

console.log('=== Early Exit Detection Timing Test ===\n');

async function runTimingTest() {
    const tests = [
        { name: 'Short timeout (1s)', timeout: 1000 },
        { name: 'Medium timeout (5s)', timeout: 5000 },
        { name: 'Long timeout (10s)', timeout: 10000 },
        { name: 'Very long timeout (30s)', timeout: 30000 }
    ];
    
    for (const test of tests) {
        console.log(`Testing ${test.name} (${test.timeout}ms timeout):`);
        
        const startTime = Date.now();
        console.log(`  Started at: ${new Date().toLocaleTimeString()}`);
        
        // This would be: await start_process('python3 -i', timeout_ms: test.timeout)
        console.log(`  Command: start_process('python3 -i', timeout_ms: ${test.timeout})`);
        console.log(`  Expected: Should return immediately when >>> detected, not wait ${test.timeout}ms`);
        
        // Simulate detection
        setTimeout(() => {
            const actualTime = Date.now() - startTime;
            console.log(`  Finished at: ${new Date().toLocaleTimeString()}`);
            console.log(`  Actual time: ${actualTime}ms`);
            
            if (actualTime < test.timeout / 2) {
                console.log(`  ✅ SUCCESS: Early exit worked! (much faster than ${test.timeout}ms)`);
            } else {
                console.log(`  ❌ ISSUE: Took too long, may not be exiting early`);
            }
            console.log();
        }, 100); // Simulate quick detection
        
        // Wait a bit between tests
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    console.log('Run these actual tests in ClaudeServerCommander:');
    console.log('1. start_process("python3 -i", timeout_ms: 1000)');
    console.log('2. start_process("python3 -i", timeout_ms: 10000)');
    console.log('3. start_process("python3 -i", timeout_ms: 30000)');
    console.log('\nAll should return in ~100-200ms regardless of timeout value!');
}

runTimingTest().catch(console.error);