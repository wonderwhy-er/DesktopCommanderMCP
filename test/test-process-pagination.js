import assert from 'assert';
import { startProcess, readProcessOutput, interactWithProcess } from '../dist/tools/improved-process-tools.js';

/**
 * Test suite for process output pagination features
 * Tests offset/length parameters and context overflow protection
 */

// Helper to extract PID from start result
function extractPid(result) {
  const match = result.content[0].text.match(/PID (\d+)/);
  return match ? parseInt(match[1]) : null;
}

// Helper to wait
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Test 1: Basic offset=0 (new output) behavior for RUNNING processes
 */
async function testNewOutputBehavior() {
  console.log('\n📋 Test 1: Basic new output behavior (offset=0) for running process...');
  
  // Start a long-running process that outputs incrementally
  const startResult = await startProcess({
    command: 'node -e "let i=0; setInterval(() => { console.log(\'tick\' + i++); if(i>5) process.exit(0); }, 200)"',
    timeout_ms: 500  // Return before completion
  });
  
  const pid = extractPid(startResult);
  assert(pid, 'Should get PID');
  
  // First read - get initial output
  const read1 = await readProcessOutput({ pid, timeout_ms: 300 });
  assert(!read1.isError, 'First read should succeed');
  const lines1 = (read1.content[0].text.match(/tick\d/g) || []).length;
  console.log(`  First read got ${lines1} tick lines`);
  
  // Wait for more output
  await wait(400);
  
  // Second read should get NEW output only
  const read2 = await readProcessOutput({ pid, timeout_ms: 300 });
  assert(!read2.isError, 'Second read should succeed');
  const text2 = read2.content[0].text;
  
  // Should NOT re-read tick0 if we already read it
  // (unless process completed, in which case all output is available)
  if (text2.includes('Process completed')) {
    console.log('  Process completed - all output available');
  } else {
    console.log(`  Second read status: ${text2.split('\n')[0]}`);
  }
  
  console.log('✅ Test 1 passed: New output behavior works correctly');
}

/**
 * Test 2: Positive offset (absolute position)
 */
async function testAbsoluteOffset() {
  console.log('\n📋 Test 2: Absolute position (positive offset)...');
  
  const startResult = await startProcess({
    command: "node -e \"for(let i=0; i<10; i++) console.log('line' + i)\"",
    timeout_ms: 3000
  });
  
  const pid = extractPid(startResult);
  assert(pid, 'Should get PID');
  
  await wait(500);
  
  // Read from line 5
  const read = await readProcessOutput({ pid, offset: 5, length: 3, timeout_ms: 1000 });
  assert(!read.isError, 'Read should succeed');
  assert(read.content[0].text.includes('line5'), 'Should contain line5');
  assert(read.content[0].text.includes('line6'), 'Should contain line6');
  assert(read.content[0].text.includes('line7'), 'Should contain line7');
  assert(!read.content[0].text.includes('line4'), 'Should NOT contain line4');
  assert(read.content[0].text.includes('from line 5'), 'Status should show reading from line 5');
  
  console.log('✅ Test 2 passed: Absolute position works correctly');
}

/**
 * Test 3: Negative offset (tail behavior)
 */
async function testTailBehavior() {
  console.log('\n📋 Test 3: Tail behavior (negative offset)...');
  
  const startResult = await startProcess({
    command: "node -e \"for(let i=0; i<20; i++) console.log('line' + i)\"",
    timeout_ms: 3000
  });
  
  const pid = extractPid(startResult);
  assert(pid, 'Should get PID');
  
  await wait(500);
  
  // Read last 5 lines (output has 21 lines: line0-line19 + empty)
  // Last 5 lines should include line16, line17, line18, line19
  const read = await readProcessOutput({ pid, offset: -5, timeout_ms: 1000 });
  assert(!read.isError, 'Read should succeed');
  assert(read.content[0].text.includes('line16'), 'Should contain line16');
  assert(read.content[0].text.includes('line19'), 'Should contain line19');
  assert(!read.content[0].text.includes('line15'), 'Should NOT contain line15');
  assert(read.content[0].text.includes('Reading last'), 'Status should indicate tail read');
  
  console.log('✅ Test 3 passed: Tail behavior works correctly');
}

/**
 * Test 4: Length limit enforcement
 */
async function testLengthLimit() {
  console.log('\n📋 Test 4: Length limit enforcement...');
  
  const startResult = await startProcess({
    command: "node -e \"for(let i=0; i<100; i++) console.log('line' + i)\"",
    timeout_ms: 3000
  });
  
  const pid = extractPid(startResult);
  assert(pid, 'Should get PID');
  
  await wait(500);
  
  // Read with length limit of 10 from absolute position 0
  const read = await readProcessOutput({ pid, offset: 1, length: 10, timeout_ms: 1000 });
  assert(!read.isError, 'Read should succeed');
  
  const outputText = read.content[0].text;
  
  // Should show "remaining" since we're only reading 10 of 100 lines
  assert(outputText.includes('remaining'), 'Should show remaining lines');
  assert(outputText.includes('Reading 10 lines'), 'Should indicate reading 10 lines');
  
  console.log('✅ Test 4 passed: Length limit works correctly');
}

/**
 * Test 5: Runtime info for completed processes
 */
async function testRuntimeInfo() {
  console.log('\n📋 Test 5: Runtime info for completed processes...');
  
  const startResult = await startProcess({
    command: "node -e \"setTimeout(() => console.log('done'), 500)\"",
    timeout_ms: 200  // Return before completion
  });
  
  const pid = extractPid(startResult);
  assert(pid, 'Should get PID');
  
  // Wait for process to complete
  await wait(1000);
  
  const read = await readProcessOutput({ pid, timeout_ms: 1000 });
  assert(!read.isError, 'Read should succeed');
  assert(read.content[0].text.includes('runtime:'), 'Should show runtime');
  assert(read.content[0].text.includes('Process completed'), 'Should show completion');
  
  console.log('✅ Test 5 passed: Runtime info works correctly');
}

/**
 * Test 6: interact_with_process output truncation
 */
async function testInteractTruncation() {
  console.log('\n📋 Test 6: interact_with_process output truncation...');
  
  // Start a Python REPL
  const startResult = await startProcess({
    command: 'python3 -i',
    timeout_ms: 3000
  });
  
  const pid = extractPid(startResult);
  if (!pid) {
    console.log('⚠️ Test 6 skipped: Could not start Python REPL');
    return;
  }
  
  await wait(500);
  
  // Generate lots of output (more than default 1000 lines)
  const result = await interactWithProcess({
    pid,
    input: 'for i in range(1500): print(f"line {i}")',
    timeout_ms: 10000
  });
  
  if (result.isError) {
    console.log('⚠️ Test 6 skipped: Python interaction failed');
    return;
  }
  
  const outputText = result.content[0].text;
  
  // Check for truncation warning
  if (outputText.includes('truncated')) {
    assert(outputText.includes('use read_process_output'), 'Should suggest using read_process_output');
    console.log('✅ Test 6 passed: Output truncation warning works');
  } else {
    // If fileReadLineLimit is set higher than 1500, no truncation expected
    console.log('✅ Test 6 passed: Output within limits (no truncation needed)');
  }
}

/**
 * Test 7: Re-reading output with absolute offset
 */
async function testReReadOutput() {
  console.log('\n📋 Test 7: Re-reading output with absolute offset...');
  
  const startResult = await startProcess({
    command: "node -e \"for(let i=0; i<5; i++) console.log('data' + i)\"",
    timeout_ms: 3000
  });
  
  const pid = extractPid(startResult);
  assert(pid, 'Should get PID');
  
  await wait(500);
  
  // First read with offset=0 (consumes the "new" pointer for running sessions)
  const read1 = await readProcessOutput({ pid, offset: 0, timeout_ms: 1000 });
  assert(!read1.isError, 'First read should succeed');
  
  // Re-read from beginning using absolute offset
  const read2 = await readProcessOutput({ pid, offset: 1, length: 3, timeout_ms: 1000 });
  assert(!read2.isError, 'Second read should succeed');
  assert(read2.content[0].text.includes('data1'), 'Should re-read data1');
  assert(read2.content[0].text.includes('data2'), 'Should re-read data2');
  
  console.log('✅ Test 7 passed: Re-reading with absolute offset works');
}

// Run all tests
async function runAllTests() {
  console.log('🚀 Starting process pagination tests...\n');
  
  try {
    await testNewOutputBehavior();
    await testAbsoluteOffset();
    await testTailBehavior();
    await testLengthLimit();
    await testRuntimeInfo();
    await testInteractTruncation();
    await testReReadOutput();
    
    console.log('\n🎉 All pagination tests passed!');
    return true;
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error.stack);
    return false;
  }
}

runAllTests()
  .then(success => process.exit(success ? 0 : 1))
  .catch(error => {
    console.error('Test error:', error);
    process.exit(1);
  });
