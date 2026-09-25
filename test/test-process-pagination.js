import assert from 'assert';
import { startProcess, readProcessOutput, interactWithProcess, forceTerminate } from '../dist/tools/improved-process-tools.js';
import { configManager } from '../dist/config-manager.js';
import { runIfMain, skip, SKIPPED } from './helpers/run-if-main.js';
import { pythonCommand } from './helpers/python.js';

/**
 * Test suite for process output pagination features
 * Tests offset/length parameters and context overflow protection
 */

// Helper to wait
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Test 1: Basic offset=0 (new output) behavior for RUNNING processes
 */
async function testNewOutputBehavior() {
  console.log('\n📋 Test 1: Basic new output behavior (offset=0) for running process...');
  
  // Start a process that prints a tick every 200ms for ~4s, so it is still running for both reads
  const startResult = await startProcess({
    command: 'node -e "let i=0; setInterval(() => { console.log(\'tick\' + i++); if(i>20) process.exit(0); }, 200)"',
    timeout_ms: 500  // Return before completion
  });
  
  const pid = startResult.structuredContent.pid;
  assert(pid, 'Should get PID');
  
  // First read - get initial output
  const read1 = await readProcessOutput({ pid, timeout_ms: 300 });
  assert(!read1.isError, 'First read should succeed');
  const ticks = (text) => text.match(/tick\d+/g) || [];
  const ticks1 = ticks(read1.content[0].text);
  console.log(`  First read got ${ticks1.length} tick lines`);

  // Wait for more output
  await wait(400);

  // Second read should get NEW output only
  const read2 = await readProcessOutput({ pid, timeout_ms: 300 });
  assert(!read2.isError, 'Second read should succeed');
  const ticks2 = ticks(read2.content[0].text);
  console.log(`  Second read got ${ticks2.length} tick lines`);

  assert(ticks2.length > 0, `Second read should return the ticks printed since the first read, got: ${read2.content[0].text}`);
  const repeated = ticks2.filter((tick) => ticks1.includes(tick));
  assert.deepStrictEqual(repeated, [], 'Second read should not repeat output already returned by the first read');
  
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
  
  const pid = startResult.structuredContent.pid;
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
  
  const pid = startResult.structuredContent.pid;
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
  
  const pid = startResult.structuredContent.pid;
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
  
  const pid = startResult.structuredContent.pid;
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
  
  // The Python the server itself detected, and the output line limit from the config
  const python = pythonCommand();
  if (!python) {
    return skip('Test 6 (interact_with_process truncation): Python 3 is not installed');
  }
  const lineLimit = (await configManager.getConfig()).fileReadLineLimit ?? 1000;
  const printedLines = lineLimit + 500;

  // Start a Python REPL
  const startResult = await startProcess({
    command: `${python} -i`,
    timeout_ms: 3000
  });

  const pid = startResult.structuredContent?.pid;
  assert(pid, `The Python REPL should start, got: ${startResult.content?.[0]?.text}`);

  await wait(500);

  try {
    // One statement runs at once; a `for` block would wait at the "..." prompt for a blank line
    const result = await interactWithProcess({
      pid,
      input: `print("\\n".join(f"line {i}" for i in range(${printedLines})))`,
      timeout_ms: 10000
    });

    assert(!result.isError, `Python interaction should succeed, got: ${result.content?.[0]?.text}`);

    const { truncated, shownLines, totalLines } = result.structuredContent;
    assert.strictEqual(truncated, true, `${printedLines} lines should exceed the ${lineLimit}-line limit`);
    assert.strictEqual(shownLines, lineLimit, 'Should show exactly the configured number of lines');
    assert(totalLines >= printedLines, `Should count all ${printedLines} printed lines, got ${totalLines}`);

    const outputText = result.content[0].text;
    assert(outputText.includes('line 0'), 'Visible output should start with the first printed line');
    assert(!outputText.includes(`line ${printedLines - 1}`), 'Lines past the limit should be hidden');
    assert(outputText.includes('Use read_process_output'), 'Should suggest using read_process_output');
    console.log(`✅ Test 6 passed: ${totalLines} lines truncated to ${shownLines} with a read_process_output hint`);
  } finally {
    await forceTerminate({ pid });
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
  
  const pid = startResult.structuredContent.pid;
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
    const results = [];
    results.push(await testNewOutputBehavior());
    results.push(await testAbsoluteOffset());
    results.push(await testTailBehavior());
    results.push(await testLengthLimit());
    results.push(await testRuntimeInfo());
    results.push(await testInteractTruncation());
    results.push(await testReReadOutput());
    
    const skipped = results.filter((result) => result === SKIPPED).length;
    console.log(skipped > 0 ? `\n🎉 Pagination tests passed, ${skipped} skipped` : '\n🎉 All pagination tests passed!');
    return true;
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error.stack);
    return false;
  }
}

runIfMain(import.meta.url, runAllTests);
