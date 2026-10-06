import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { startProcess, readProcessOutput, interactWithProcess, forceTerminate } from '../dist/tools/improved-process-tools.js';
import { terminalManager } from '../dist/terminal-manager.js';
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
  const tickNumber = (tick) => Number(tick.slice('tick'.length));
  assert.strictEqual(tickNumber(ticks2[0]), tickNumber(ticks1[ticks1.length - 1]) + 1,
    `Second read should start with the tick right after the first read's last (none lost), got ${ticks1.join(',')} then ${ticks2.join(',')}`);
  
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
  
  // Read last 5 lines (output has 20 lines: line0-line19; the nothing after
  // the final newline is not a line). Last 5 lines are line15 to line19
  const read = await readProcessOutput({ pid, offset: -5, timeout_ms: 1000 });
  assert(!read.isError, 'Read should succeed');
  assert(read.content[0].text.includes('line15'), `Should contain line15, got: ${read.content[0].text}`);
  assert(read.content[0].text.includes('line19'), 'Should contain line19');
  assert(!read.content[0].text.includes('line14'), 'Should NOT contain line14');
  assert(read.content[0].text.startsWith('[Reading last 5 lines (total: 20 lines)]'),
    `Status should count the 20 lines printed, got: ${read.content[0].text.split('\n')[0]}`);
  
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

/**
 * Test 8: Counts agree with what can be read. Output ending in a newline has
 * nothing after that newline: no empty line is counted in total or remaining,
 * or returned, while the process runs or after it exits.
 */
async function testCountsAfterTrailingNewline() {
  console.log('\n📋 Test 8: Line counts for output ending in a newline...');

  // Prints "done", then exits once the trigger file exists, or after 15s on
  // its own, so a failing run (no trigger) leaves nothing running
  const trigger = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-pagination-')), 'exit');
  const startResult = await startProcess({
    command: `node -e "console.log('done'); setTimeout(() => process.exit(0), 15000).unref(); const t = setInterval(() => { if (require('fs').existsSync(process.argv[1])) clearInterval(t); }, 20)" "${trigger}"`,
    timeout_ms: 1000
  });
  const pid = startResult.structuredContent.pid;
  assert(pid, 'Should get PID');
  const statusLine = (result) => result.content[0].text.split('\n')[0];

  try {
    const read1 = await readProcessOutput({ pid, timeout_ms: 1000 });
    assert(read1.content[0].text.includes('done'), `The first read should return "done", got: ${read1.content[0].text}`);
    assert.strictEqual(statusLine(read1), '[Reading 1 new lines (total: 1 lines)]', 'The one line printed is the only line counted');
    const read2 = await readProcessOutput({ pid, timeout_ms: 300 });
    assert.strictEqual(statusLine(read2), '[Reading 0 new lines (total: 1 lines)]', 'A second read has no line to return');
    const tail = await readProcessOutput({ pid, offset: -5 });
    assert.strictEqual(statusLine(tail), '[Reading last 1 lines (total: 1 lines)]', 'The last lines are the one line printed');

    fs.writeFileSync(trigger, '');
    for (let i = 0; i < 100 && terminalManager.getSession(pid); i++) await wait(50);
    assert.strictEqual(terminalManager.getSession(pid), undefined, 'The process should have exited');

    const read3 = await readProcessOutput({ pid, timeout_ms: 1000 });
    assert.strictEqual(statusLine(read3), '[Reading 0 new lines (total: 1 lines)]', 'After the exit, still no line left to read');
    assert(read3.content[0].text.includes('(No output in requested range)'), `No line to return after the exit, got: ${read3.content[0].text}`);
    const absolute = await readProcessOutput({ pid, offset: 1, length: 5 });
    assert.strictEqual(statusLine(absolute), '[Reading 0 lines from line 1 (total: 1 lines, 0 remaining)]', 'Nothing after the one line printed');
  } finally {
    // Best-effort: a trigger dir left in the temp folder is harmless
    fs.rmSync(path.dirname(trigger), { recursive: true, force: true });
  }

  console.log('✅ Test 8 passed: counts leave out the empty line after a trailing newline');
}

// Run all tests: every test runs and reports, even after an earlier one fails
async function runAllTests() {
  console.log('🚀 Starting process pagination tests...\n');

  const tests = [
    testNewOutputBehavior,
    testAbsoluteOffset,
    testTailBehavior,
    testLengthLimit,
    testRuntimeInfo,
    testInteractTruncation,
    testReReadOutput,
    testCountsAfterTrailingNewline,
  ];
  const failures = [];
  let skipped = 0;
  for (const test of tests) {
    try {
      if ((await test()) === SKIPPED) skipped++;
    } catch (error) {
      failures.push(test.name);
      console.error(`\n❌ ${test.name} failed: ${error.message}`);
    }
  }

  if (failures.length === 0) {
    console.log(skipped > 0 ? `\n🎉 Pagination tests passed, ${skipped} skipped` : '\n🎉 All pagination tests passed!');
    return true;
  }
  console.error(`\n❌ ${failures.length} of ${tests.length} pagination tests failed: ${failures.join(', ')}`);
  return false;
}

runIfMain(import.meta.url, runAllTests);
