/**
 * Process-state detection with a REPL that writes its prompt to stderr and its
 * results to stdout, as python -i and bash -i do. Uses a small fake REPL
 * (fixtures/stderr-prompt-repl.js) so the checks don't depend on Python.
 *
 * stdout and stderr reach the server through separate pipes. When both have
 * data waiting, the server receives them in the same event-loop turn, in
 * either order: python -i's last stdout chunk (the final "\r\n" of a print)
 * regularly arrives after its ">>> " prompt when the output is large or the
 * server is busy. Detection used to judge the merged output in arrival order,
 * saw "…>>> \r\n" end in an empty line, missed the prompt, and
 * interact_with_process waited out its whole timeout.
 *
 * To reproduce that arrival order every run, the fake REPL writes the prompt
 * just before the output, and the test keeps the event loop busy while it
 * answers (as a server busy with other work would be), so both pipes are
 * delivered in the next turn, prompt first.
 *
 * The cost checks at the end cover detection reading only the end of the
 * output: it used to split and regex-scan all output since the snapshot on
 * every interact_with_process poll (quadratic in one interaction's output),
 * and to join the whole session buffer on every read_process_output call.
 */
import assert from 'assert';
import path from 'path';
import { performance } from 'perf_hooks';
import { fileURLToPath } from 'url';
import { startProcess, interactWithProcess, readProcessOutput, forceTerminate } from '../dist/tools/improved-process-tools.js';
import { terminalManager } from '../dist/terminal-manager.js';
import { runIfMain } from './helpers/run-if-main.js';

const FAKE_REPL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stderr-prompt-repl.js');

// The fake REPL answers 150ms after reading a line; the event loop is kept
// busy well past that, so both of its writes are waiting when it frees up,
// even when a loaded machine is slow to run the REPL.
const BUSY_MS = 3000;
const INTERACT_TIMEOUT_MS = 30000;
// A prompt detected when the output arrives returns within a few polls of the
// busy period; missing it runs to INTERACT_TIMEOUT_MS, twice this.
const PROMPT_DETECTED_WITHIN_MS = 15000;
// Deadline of a wait that ends as soon as what it waits for comes
const EVENT_DEADLINE_MS = 30000;

// read_process_output on a session holding ~33MB of short lines: joining and
// scanning all of it took ~230ms per call; the tail check takes well under 1ms.
// The limit is a share of what joining that buffer takes here, now, so a
// loaded machine slows both; the old check, a join and more, took longer.
const BIG_SESSION_LINES = 3_000_000;
const MAX_SHARE_OF_JOIN = 0.25;
// One interaction printing ~8MB of short lines over STREAM_MS. Rescanning all
// of its output on every 50ms poll kept the event loop ~22% busy, a share that
// grows with the interaction's length; reading just the new output and the
// tail keeps it at ~2%. On a loaded machine just taking in the stream keeps
// the loop busier, so the limit grows with what that alone costs here: up to
// MAX_TIMES_INTAKE times it, never under MAX_STREAM_LOOP_BUSY. Under coverage
// (c8) the polling, which is our JavaScript, slows more than the intake, which
// is mostly Node's own: on a slow machine it reached 4 times the intake. The
// rescanning above costs ~10 times what the fix does, so 6 still catches it.
const STREAM_LINES = 750_000;
const STREAM_MS = 10_000;
const MAX_STREAM_LOOP_BUSY = 0.10;
const MAX_TIMES_INTAKE = 6;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function blockEventLoop(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy, like a server handling other work */ }
}

async function startFakeRepl(promptName) {
  const started = await startProcess({ command: `node "${FAKE_REPL}" ${promptName}`, timeout_ms: EVENT_DEADLINE_MS });
  const pid = started.structuredContent?.pid;
  assert.ok(pid > 0, `start_process should start the fake REPL, got: ${started.content[0].text}`);
  assert.strictEqual(started.structuredContent.status, 'waiting_for_input',
    `start_process should report the fake REPL's first prompt, got: ${started.content[0].text}`);
  return pid;
}

/** interact_with_process, with the event loop kept busy while the REPL answers. */
async function interactWhileBusy(pid, input) {
  const startedAt = Date.now();
  const pending = interactWithProcess({ pid, input, timeout_ms: INTERACT_TIMEOUT_MS });
  // Runs after interact_with_process has sent the input (it does so before its first timer)
  setTimeout(() => blockEventLoop(BUSY_MS), 0);
  const result = await pending;
  return { result, ms: Date.now() - startedAt };
}

async function testPromptArrivesBeforeOutput(promptName) {
  console.log(`\n--- ${promptName} prompt on stderr delivered before the rest of stdout ---`);
  const pid = await startFakeRepl(promptName);
  try {
    const { result, ms } = await interactWhileBusy(pid, 'prompt-first hello');
    const text = result.content[0].text;
    console.log(`interact_with_process returned after ${ms}ms with status ${result.structuredContent.status}`);
    assert.ok(text.includes('hello'), `the REPL's output should be returned, got: ${text}`);
    assert.strictEqual(result.structuredContent.status, 'waiting_for_input',
      `the prompt should be detected, got: ${text}`);
    assert.ok(ms < PROMPT_DETECTED_WITHIN_MS,
      `interact_with_process should return once the prompt arrives, took ${ms}ms (timeout ${INTERACT_TIMEOUT_MS}ms)`);

    const read = (await readProcessOutput({ pid, timeout_ms: 1000 })).content[0].text;
    assert.ok(read.includes(`Process ${pid} is waiting for input`),
      `read_process_output should report the prompt too, got: ${read}`);
    console.log('ok: prompt detected by interact_with_process and read_process_output');
  } finally {
    await forceTerminate({ pid });
  }
}

async function testOutputArrivesBeforePrompt() {
  console.log('\n--- stdout delivered before the stderr prompt (the usual order) ---');
  const pid = await startFakeRepl('python');
  try {
    const { result, ms } = await interactWhileBusy(pid, 'output-first hello');
    console.log(`interact_with_process returned after ${ms}ms with status ${result.structuredContent.status}`);
    assert.ok(result.content[0].text.includes('hello'), result.content[0].text);
    assert.strictEqual(result.structuredContent.status, 'waiting_for_input', result.content[0].text);
    assert.ok(ms < PROMPT_DETECTED_WITHIN_MS, `took ${ms}ms (timeout ${INTERACT_TIMEOUT_MS}ms)`);
    console.log('ok: prompt detected');
  } finally {
    await forceTerminate({ pid });
  }
}

async function testOutputInALaterTurnFollowsThePrompt() {
  console.log('\n--- stdout output arriving in a later turn than the prompt was written after it ---');
  // e.g. the next statement of a multi-line input printing while it still runs:
  // the prompt isn't the last thing the process wrote, so it isn't waiting.
  const pid = await startFakeRepl('python');
  try {
    const sent = await interactWithProcess({ pid, input: 'later-output still running', wait_for_prompt: false });
    assert.notStrictEqual(sent.isError, true, sent.content[0].text);
    // The output follows the prompt after 300ms; read until it has come, which
    // on a loaded machine can take longer. The read that brings it is judged.
    let read = '';
    for (const deadline = Date.now() + EVENT_DEADLINE_MS; !read.includes('still running') && Date.now() < deadline;) {
      read = (await readProcessOutput({ pid, timeout_ms: 1000 })).content[0].text;
    }
    assert.ok(read.includes('still running'), `the later output should have arrived, got: ${read}`);
    assert.ok(!read.includes('is waiting for input'),
      `output written after the prompt means the process is not waiting, got: ${read}`);
    console.log('ok: not reported as waiting for input');
  } finally {
    await forceTerminate({ pid });
  }
}

async function testReadStateCheckCost() {
  console.log(`\n--- read_process_output's state check on a session holding ${BIG_SESSION_LINES} lines ---`);
  const pid = await startFakeRepl('python');
  try {
    const expectedLines = terminalManager.getOutputLineCount(pid) + BIG_SESSION_LINES;
    await interactWithProcess({ pid, input: `lines ${BIG_SESSION_LINES} 10`, wait_for_prompt: false });
    // Wait on the raw buffer, not on detection: all lines in, the prompt last
    const lastLine = () => terminalManager.readOutputPaginated(pid, -1, 1).lines[0];
    const deadline = Date.now() + 60000;
    while ((terminalManager.getOutputLineCount(pid) < expectedLines || lastLine() !== '>>> ') && Date.now() < deadline) {
      await sleep(100);
    }
    assert.strictEqual(terminalManager.getOutputLineCount(pid), expectedLines, 'all lines should have arrived');
    assert.strictEqual(lastLine(), '>>> ', 'the prompt should have arrived after them');

    // What the old check's join of the whole buffer alone takes here and now
    const joins = [];
    let joinedChars = 0;
    for (let i = 0; i < 3; i++) {
      const startedAt = performance.now();
      joinedChars = terminalManager.getSession(pid).outputLines.join('\n').length;
      joins.push(performance.now() - startedAt);
    }
    const joinMs = joins.sort((a, b) => a - b)[1];
    const limitMs = MAX_SHARE_OF_JOIN * joinMs;

    const times = [];
    let read = '';
    for (let i = 0; i < 5; i++) {
      const startedAt = performance.now();
      read = (await readProcessOutput({ pid, offset: -1, length: 1 })).content[0].text;
      times.push(performance.now() - startedAt);
    }
    const medianMs = times.sort((a, b) => a - b)[2];
    console.log(`read_process_output tail reads: ${times.map((ms) => ms.toFixed(1)).join(', ')}ms (median ${medianMs.toFixed(1)}ms; joining the ${joinedChars} chars takes ${joinMs.toFixed(1)}ms)`);
    assert.ok(medianMs < limitMs,
      `the state check should not scale with the buffer: median ${medianMs.toFixed(1)}ms (limit ${limitMs.toFixed(1)}ms, ${MAX_SHARE_OF_JOIN} of a ${joinMs.toFixed(1)}ms join of the buffer)`);
    assert.ok(read.includes(`Process ${pid} is waiting for input`), `the final prompt should be detected, got: ${read}`);
    console.log('ok: state check cost independent of the buffer size');
  } finally {
    await forceTerminate({ pid });
  }
}

/** The event loop's busy share while the same stream comes in with nothing polling it: what taking it in alone costs here, now */
async function streamIntakeUtilization() {
  const pid = await startFakeRepl('python');
  try {
    const expectedLines = terminalManager.getOutputLineCount(pid) + STREAM_LINES;
    const eluBefore = performance.eventLoopUtilization();
    await interactWithProcess({ pid, input: `stream ${STREAM_LINES} 10 ${STREAM_MS}`, wait_for_prompt: false });
    // Wait on the raw buffer, not on detection: all lines in, the prompt last
    const lastLine = () => terminalManager.readOutputPaginated(pid, -1, 1).lines[0];
    const deadline = Date.now() + 60000;
    while ((terminalManager.getOutputLineCount(pid) < expectedLines || lastLine() !== '>>> ') && Date.now() < deadline) {
      await sleep(100);
    }
    const elu = performance.eventLoopUtilization(eluBefore);
    assert.strictEqual(lastLine(), '>>> ', 'the stream and the prompt after it should have arrived');
    return elu.utilization;
  } finally {
    await forceTerminate({ pid });
  }
}

async function testInteractionStateCheckCost() {
  console.log(`\n--- one interaction printing ${STREAM_LINES} lines over ${STREAM_MS}ms ---`);
  const intake = await streamIntakeUtilization();
  const limit = Math.max(MAX_STREAM_LOOP_BUSY, MAX_TIMES_INTAKE * intake);
  const pid = await startFakeRepl('python');
  try {
    const eluBefore = performance.eventLoopUtilization();
    const result = await interactWithProcess({ pid, input: `stream ${STREAM_LINES} 10 ${STREAM_MS}`, timeout_ms: 30000 });
    const elu = performance.eventLoopUtilization(eluBefore);
    console.log(`event loop busy ${(elu.utilization * 100).toFixed(1)}% (${elu.active.toFixed(0)}ms of ${(elu.active + elu.idle).toFixed(0)}ms; ${(intake * 100).toFixed(1)}% taking the stream in unpolled), status ${result.structuredContent.status}`);
    assert.ok(elu.utilization < limit,
      `polling one long interaction should leave the event loop mostly idle: busy ${(elu.utilization * 100).toFixed(1)}% (limit ${(limit * 100).toFixed(1)}%, ${(intake * 100).toFixed(1)}% without polling)`);
    assert.strictEqual(result.structuredContent.status, 'waiting_for_input', result.content[0].text.slice(-500));
    console.log('ok: event loop mostly idle');
  } finally {
    await forceTerminate({ pid });
  }
}

async function runAllTests() {
  await testPromptArrivesBeforeOutput('python');
  await testPromptArrivesBeforeOutput('shell');
  await testOutputArrivesBeforePrompt();
  await testOutputInALaterTurnFollowsThePrompt();
  await testReadStateCheckCost();
  await testInteractionStateCheckCost();
  console.log('\n✅ process state detection tests passed');
}

runIfMain(import.meta.url, runAllTests);

export default runAllTests;
