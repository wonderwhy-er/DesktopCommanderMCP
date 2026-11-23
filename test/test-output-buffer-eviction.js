/**
 * A session past the output buffer cap (MAX_BUFFERED_OUTPUT_CHARS) evicts its
 * oldest lines as new output arrives. Eviction used to drop them one shift()
 * at a time; once the buffer holds hundreds of thousands of lines, every
 * shift() copies the whole array, so each output chunk blocked the server's
 * event loop for about a second (100-char lines) or much longer (short
 * lines). This fills a session to the cap with 100-char lines, then times how
 * long more of them take to absorb, against the same lines into an empty
 * session timed in the same run, so a loaded machine slows both.
 */
import assert from 'assert';
import path from 'path';
import { fileURLToPath } from 'url';
import { startProcess, interactWithProcess, forceTerminate } from '../dist/tools/improved-process-tools.js';
import { terminalManager, MAX_BUFFERED_OUTPUT_CHARS } from '../dist/terminal-manager.js';
import { runIfMain } from './helpers/run-if-main.js';

const FAKE_REPL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'stderr-prompt-repl.js');

const LINE_WIDTH = 100;
// ~4MB past the cap: ~40000 lines to evict from a ~519000-line buffer. Evicting
// them one shift() at a time took ~0.9ms each (~36s); in bulk, well under a second.
const OVERFLOW_LINES = 40_000;
// The overflow into a full session may take this many times as long as the same
// lines into an empty one, plus SLACK_MS for the bulk eviction and the polling:
// a second or two either way, against the old eviction's ~36s
const MAX_SLOWDOWN = 10;
const SLACK_MS = 1000;
// Longest wait for lines to arrive; it ends as soon as they are in
const ARRIVAL_DEADLINE_MS = 120_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How many lines the session has had (evicted ones included), and whether the prompt ends them */
function linesIn(pid) {
  const tail = terminalManager.readOutputPaginated(pid, -1, 1);
  return { count: tail.evictedLines + tail.totalLines, evicted: tail.evictedLines, atPrompt: tail.lines[0] === '>>> ' };
}

/** Has the fake REPL print `count` lines, and resolves with how long they and the prompt after them took to arrive */
async function absorbLines(pid, count) {
  const target = linesIn(pid).count + count;
  const startedAt = Date.now();
  await interactWithProcess({ pid, input: `lines ${count} ${LINE_WIDTH}`, wait_for_prompt: false });
  const absorbed = () => {
    const now = linesIn(pid);
    return now.count >= target && now.atPrompt;
  };
  while (!absorbed() && Date.now() - startedAt < ARRIVAL_DEADLINE_MS) {
    await sleep(10);
  }
  assert.ok(absorbed(), `${count} lines and the prompt after them should arrive within ${ARRIVAL_DEADLINE_MS}ms`);
  return Date.now() - startedAt;
}

/** Runs `run` with a fresh fake REPL's pid, then ends it */
async function withFakeRepl(run) {
  const started = await startProcess({ command: `node "${FAKE_REPL}"`, timeout_ms: 30000 });
  const pid = started.structuredContent?.pid;
  assert.ok(pid > 0, `start_process should start the fake REPL, got: ${started.content[0].text}`);
  try {
    return await run(pid);
  } finally {
    await forceTerminate({ pid });
  }
}

async function testOverflowAbsorbedQuickly() {
  const capLines = Math.ceil(MAX_BUFFERED_OUTPUT_CHARS / (LINE_WIDTH + 1));
  console.log(`\n--- ${OVERFLOW_LINES} lines of ${LINE_WIDTH} chars into a session holding the cap (${MAX_BUFFERED_OUTPUT_CHARS} chars), against an empty one ---`);
  const emptyMs = await withFakeRepl((pid) => absorbLines(pid, OVERFLOW_LINES));

  await withFakeRepl(async (pid) => {
    await absorbLines(pid, capLines);
    const evictedBefore = linesIn(pid).evicted;

    // Longest time the event loop was unavailable, sampled every 20ms
    let longestBlockMs = 0;
    let lastTick = Date.now();
    const monitor = setInterval(() => {
      const now = Date.now();
      longestBlockMs = Math.max(longestBlockMs, now - lastTick - 20);
      lastTick = now;
    }, 20);
    let absorbMs;
    try {
      absorbMs = await absorbLines(pid, OVERFLOW_LINES);
    } finally {
      clearInterval(monitor);
    }

    const { evicted } = linesIn(pid);
    const limitMs = MAX_SLOWDOWN * emptyMs + SLACK_MS;
    console.log(`absorbed in ${absorbMs}ms (into an empty session ${emptyMs}ms, limit ${limitMs}ms), longest event-loop block ${longestBlockMs}ms, ${evicted - evictedBefore} lines evicted`);
    assert.ok(evicted - evictedBefore >= OVERFLOW_LINES / 2, `the buffer cap should have evicted most of the overflow, evicted ${evicted - evictedBefore}`);
    assert.ok(absorbMs < limitMs,
      `evicting ${evicted - evictedBefore} lines should not stall the server: took ${absorbMs}ms, ${emptyMs}ms into an empty session (limit ${limitMs}ms)`);
    console.log('ok: overflow absorbed without stalling');
  });
}

runIfMain(import.meta.url, testOverflowAbsorbedQuickly);

export default testOverflowAbsorbedQuickly;
