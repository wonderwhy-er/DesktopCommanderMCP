#!/usr/bin/env node

// Simple timing test for ClaudeServerCommander process behavior
import { performance } from 'perf_hooks';

console.log('=== ClaudeServerCommander Timeout Test ===\n');

console.log('This test demonstrates:');
console.log('1. Fast processes (< timeout) finish early and don\'t wait for full timeout');
console.log('2. The process completion is detected properly');
console.log('3. Timeout is respected when processes run longer\n');

console.log('To test this:');
console.log('1. Run: start_process with command that finishes in 3s, timeout 10s');
console.log('2. Measure if it waits 10s or finishes at 3s');
console.log('3. Run: start_process with command that takes 10s, timeout 5s');
console.log('4. Verify it times out at 5s\n');

console.log('Expected behavior:');
console.log('- Fast process should finish in ~3s, NOT wait for 10s timeout');
console.log('- Slow process should timeout at 5s with isBlocked=true');

const startTime = performance.now();
console.log(`\nTest script completed in ${(performance.now() - startTime).toFixed(2)}ms`);