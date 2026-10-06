/**
 * test/helpers/process-memory.js samples the memory of a process and its
 * children for the #716 repro (test/repro/test-search-memory.js). When it
 * can't sample (no ps or PowerShell to run, or ps output past its buffer), it
 * must say so: peaks of 0 read as a search that stayed within its limits.
 */
import assert from 'assert';
import { watchPeakMemory } from './helpers/process-memory.js';
import { runIfMain } from './helpers/run-if-main.js';

/** Time for the first sample: PowerShell takes a second or two to start on Windows */
const SETTLE_MS = 20_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `check()` once it is truthy, or its last value after `ms` */
async function until(check, ms) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await sleep(100);
  return check();
}

async function testSamplesThisProcess() {
  console.log('\nTest 1: the helper samples this process');
  const memory = watchPeakMemory(process.pid);
  try {
    const peak = await until(() => memory.peakOf(process.pid), SETTLE_MS);
    assert(peak > 0, `this process should have been sampled within ${SETTLE_MS} ms`);
    assert.strictEqual(memory.failure(), undefined, 'sampling that works should report no failure');
    console.log('✓ Test 1 passed');
  } finally {
    memory.stop();
  }
}

async function testFailedSamplingIsReported() {
  console.log('\nTest 2: sampling that can\'t run is reported');
  // Without a PATH the helper finds neither ps nor PowerShell
  const savedPath = process.env.PATH;
  process.env.PATH = '';
  let memory;
  try {
    memory = watchPeakMemory(process.pid);
  } finally {
    process.env.PATH = savedPath;
  }
  try {
    const failure = await until(() => memory.failure?.(), SETTLE_MS);
    assert(failure, `sampling that can't run should be reported, got a peak of ${memory.peakOf(process.pid)} bytes and no failure`);
    console.log(`✓ Test 2 passed: ${failure}`);
  } finally {
    memory.stop();
  }
}

export default async function runTests() {
  let failed = 0;
  for (const test of [testSamplesThisProcess, testFailedSamplingIsReported]) {
    try {
      await test();
    } catch (error) {
      failed++;
      console.error('❌ Test failed:', error.message);
    }
  }
  return failed === 0;
}

runIfMain(import.meta.url, runTests);
