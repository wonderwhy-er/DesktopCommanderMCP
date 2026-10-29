#!/usr/bin/env node

/**
 * A long-lived child may keep producing output after start_process has already
 * returned. The start-process wait/timing machinery must stop at that point:
 * later output is buffered for read_process_output, but must not keep running
 * process-state detection or grow the returned timing event array forever.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TerminalManager } from '../dist/terminal-manager.js';

class CountingTerminalManager extends TerminalManager {
  constructor() {
    super();
    this.stateChecks = 0;
  }

  getProcessState(...args) {
    this.stateChecks++;
    return super.getProcessState(...args);
  }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const tm = new CountingTerminalManager();
let pid;

try {
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'post-resolve-output.js');
  // The fixture prints a real prompt first so start_process resolves immediately,
  // then keeps producing output that is guaranteed to arrive after that response.
  const command = `node "${fixture}"`;
  const shell = process.platform === 'win32' ? 'cmd.exe' : undefined;
  const started = await tm.executeCommand(command, 2_000, shell, true, 2_000);
  pid = started.pid;

  assert.ok(pid > 0, `expected a running child PID, got ${pid}`);
  assert.ok(started.timingInfo, 'collectTiming=true should return timingInfo');

  const checksAtResolve = tm.stateChecks;
  const timingEventsAtResolve = started.timingInfo.outputEvents?.length ?? 0;
  const outputAtResolve = tm.captureOutputSnapshot(pid);
  assert.ok(outputAtResolve, 'running child should have an output snapshot after start_process resolves');

  // Do not rely on a fixed sleep: scheduling and pipe delivery can be slow on a
  // busy runner. Wait until output that is definitely newer than the resolved
  // result has arrived, without calling process-state detection from the test itself.
  const deadline = Date.now() + 5_000;
  let postResolveOutput = '';
  while (Date.now() < deadline) {
    postResolveOutput = tm.readOutputSince(pid, outputAtResolve)?.output ?? '';
    if (
      postResolveOutput.includes('post-resolve-stdout')
      && postResolveOutput.includes('post-resolve-stderr')
    ) break;
    await sleep(25);
  }
  assert.match(postResolveOutput, /post-resolve-stdout/, 'child should produce stdout after resolve');
  assert.match(postResolveOutput, /post-resolve-stderr/, 'child should produce stderr after resolve');

  assert.equal(
    tm.stateChecks,
    checksAtResolve,
    'process-state detection must stop after start_process resolves'
  );
  assert.equal(
    started.timingInfo.outputEvents?.length ?? 0,
    timingEventsAtResolve,
    'returned timing events must not keep growing after start_process resolves'
  );

  const buffered = tm.readOutputPaginated(pid, 0, 50);
  assert.ok(buffered, 'session output should remain readable after wait machinery stops');
  assert.ok(
    buffered.lines.some(line => line.includes('post-resolve-stdout')),
    'stdout should remain buffered for later read_process_output calls'
  );
  assert.ok(
    buffered.lines.some(line => line.includes('post-resolve-stderr')),
    'stderr should remain buffered for later read_process_output calls'
  );

  console.log('✅ start_process post-resolve monitoring/timing cleanup test passed');
} finally {
  if (pid) await tm.forceTerminate(pid);
}
