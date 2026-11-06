/** Sampler controls and real process measurement; no missing sample counts as a measurement. */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { watchPeakMemory } from './helpers/process-memory.js';

/** Preserve the existing first-sample budget, including PowerShell startup. */
const SETTLE_MS = 20_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, ms) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await sleep(100);
  return check();
}

async function withWindowsSampler(testContext, check) {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const sampler = new EventEmitter();
  sampler.stdout = new PassThrough();
  sampler.stderr = new PassThrough();
  let stops = 0;
  sampler.kill = () => { stops++; };
  let launch;
  testContext.mock.method(childProcess, 'spawn', (program, args, options) => {
    launch = { program, args, options };
    return sampler;
  });
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  syncBuiltinESMExports();
  let memory;
  try {
    memory = watchPeakMemory(process.pid);
    await check({ memory, sampler, launch, stops: () => stops });
  } finally {
    memory?.stop();
    testContext.mock.restoreAll();
    Object.defineProperty(process, 'platform', platform);
    syncBuiltinESMExports();
    sampler.stdout.destroy();
    sampler.stderr.destroy();
  }
}

test('Windows sampler distinguishes launch, script startup and a query that has not returned', async (testContext) => {
  await withWindowsSampler(testContext, ({ memory, sampler, launch }) => {
    assert.equal(launch.program, 'powershell.exe');
    assert.deepEqual(launch.options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(memory.diagnostics().spawned, false);
    sampler.emit('spawn');
    sampler.stdout.write('DC_MEMORY_READY\nDC_MEMORY_QUERY_STARTED\n');
    const observed = memory.diagnostics();
    assert.equal(observed.spawned, true);
    assert.equal(observed.scriptStarted, true);
    assert.equal(observed.queriesStarted, 1);
    assert.equal(observed.queriesCompleted, 0);
    assert.equal(observed.samples, 0);
    assert.equal(memory.peakOf(process.pid), 0);
    assert.equal(memory.failure(), undefined);
    observed.samples = 99;
    assert.equal(memory.diagnostics().samples, 0, 'diagnostics are a snapshot');
  });
});

test('fragmented Windows samples preserve peak bytes and report only counters', async (testContext) => {
  await withWindowsSampler(testContext, ({ memory, sampler }) => {
    sampler.stdout.write('DC_MEMORY_RE');
    sampler.stdout.write('ADY\r\nDC_MEMORY_QUERY_STARTED\nDC_MEMORY_QUERY_DONE 1\n');
    sampler.stdout.write(`${process.pid} node.exe 12`);
    sampler.stdout.write(`8\r\n${process.pid} node.exe 64\n`);
    assert.equal(memory.peakOf(process.pid), 128 * 1024);
    assert.equal(memory.peakOfName('node'), 128 * 1024);
    assert.equal(memory.diagnostics().samples, 2);
    assert.equal(memory.diagnostics().lastQueryRows, 1);
    assert.equal(memory.diagnostics().queriesCompleted, 1);
    assert.equal(memory.diagnostics().unparsedLines, 0);
    assert.equal(memory.failure(), undefined);
  });
});

test('empty CIM queries stay unmeasured and malformed output is counted without retaining text',
  async (testContext) => {
  await withWindowsSampler(testContext, ({ memory, sampler }) => {
    sampler.stdout.write('DC_MEMORY_QUERY_STARTED\nDC_MEMORY_QUERY_DONE 0\n');
    sampler.stdout.write('private-output-must-not-appear\n');
    sampler.stderr.write('private-error-must-not-appear');
    const observed = memory.diagnostics();
    assert.equal(observed.lastQueryRows, 0);
    assert.equal(observed.samples, 0);
    assert.equal(observed.unparsedLines, 1);
    assert.equal(observed.stderrBytes, Buffer.byteLength('private-error-must-not-appear'));
    assert.equal(JSON.stringify(observed).includes('private-'), false);
    assert.equal(memory.peakOf(process.pid), 0);
  });
});

test('a CIM query failure is explicit without exposing the PowerShell error body', async (testContext) => {
  await withWindowsSampler(testContext, ({ memory, sampler, launch }) => {
    const script = launch.args.at(-1);
    assert.ok(script.includes('-ErrorAction Stop'));
    assert.ok(script.includes('DC_MEMORY_QUERY_FAILED'));
    sampler.stdout.write('DC_MEMORY_QUERY_STARTED\nDC_MEMORY_QUERY_FAILED\n');
    assert.equal(memory.diagnostics().queriesFailed, 1);
    assert.match(memory.failure(), /could not query process memory/);
    assert.equal(memory.peakOf(process.pid), 0);
  });
});

test('unexpected sampler exit and spawn failure remain failures', async (testContext) => {
  await withWindowsSampler(testContext, ({ memory, sampler }) => {
    sampler.emit('exit', 23, null);
    assert.equal(memory.diagnostics().exited, true);
    assert.equal(memory.diagnostics().exitCode, 23);
    assert.match(memory.failure(), /exit code 23/);
    sampler.emit('error', new Error('controlled spawn failure'));
    assert.match(memory.failure(), /exit code 23/, 'retain the first failure');
  });
});

test('stopping the sampler kills its child without recording a sampling failure', async (testContext) => {
  await withWindowsSampler(testContext, ({ memory, sampler, stops }) => {
    memory.stop();
    assert.equal(stops(), 1);
    sampler.emit('exit', null, 'SIGTERM');
    assert.equal(memory.failure(), undefined);
  });
});

test('the helper samples this process within the unchanged first-sample budget', async () => {
  const memory = watchPeakMemory(process.pid);
  try {
    const peak = await until(() => memory.peakOf(process.pid), SETTLE_MS);
    assert(peak > 0,
      `this process should have been sampled within ${SETTLE_MS} ms; ` +
      `diagnostics: ${JSON.stringify(memory.diagnostics())}`);
    assert.strictEqual(memory.failure(), undefined, 'sampling that works should report no failure');
  } finally {
    memory.stop();
  }
});

test('sampling that cannot run is reported instead of a zero-byte measurement', async () => {
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
    assert(failure,
      `sampling that cannot run should fail; peak: ${memory.peakOf(process.pid)}; ` +
      `diagnostics: ${JSON.stringify(memory.diagnostics())}`);
  } finally {
    memory.stop();
  }
});
