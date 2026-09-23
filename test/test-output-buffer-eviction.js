/**
 * A session past the output buffer cap (MAX_BUFFERED_OUTPUT_CHARS) evicts its
 * oldest lines as new output arrives. Eviction used to drop them one shift()
 * at a time; once the buffer holds hundreds of thousands of lines, every
 * shift() copies the whole array, so each output chunk blocked the server's
 * event loop for about a second (100-char lines) or much longer (short
 * lines). This fills a session just past the cap with 100-char lines and
 * checks how long the overflow takes to absorb.
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
const MAX_ABSORB_MS = 10_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testOverflowAbsorbedQuickly() {
  const lines = Math.ceil(MAX_BUFFERED_OUTPUT_CHARS / (LINE_WIDTH + 1)) + OVERFLOW_LINES;
  console.log(`\n--- ${lines} lines of ${LINE_WIDTH} chars into one session (cap ${MAX_BUFFERED_OUTPUT_CHARS} chars) ---`);
  const started = await startProcess({ command: `node "${FAKE_REPL}"`, timeout_ms: 10000 });
  const pid = started.structuredContent?.pid;
  assert.ok(pid > 0, `start_process should start the fake REPL, got: ${started.content[0].text}`);
  try {
    // Longest time the event loop was unavailable, sampled every 20ms
    let longestBlockMs = 0;
    let lastTick = Date.now();
    const monitor = setInterval(() => {
      const now = Date.now();
      longestBlockMs = Math.max(longestBlockMs, now - lastTick - 20);
      lastTick = now;
    }, 20);

    const startedAt = Date.now();
    await interactWithProcess({ pid, input: `lines ${lines} ${LINE_WIDTH}`, wait_for_prompt: false });
    // All lines in (evicted ones included) and the prompt after them
    const absorbed = () => {
      const tail = terminalManager.readOutputPaginated(pid, -1, 1);
      return tail.evictedLines + tail.totalLines > lines && tail.lines[0] === '>>> ';
    };
    while (!absorbed() && Date.now() - startedAt < 120_000) {
      await sleep(50);
    }
    const absorbMs = Date.now() - startedAt;
    clearInterval(monitor);

    const tail = terminalManager.readOutputPaginated(pid, -1, 1);
    console.log(`absorbed in ${absorbMs}ms, longest event-loop block ${longestBlockMs}ms, ${tail.evictedLines} lines evicted, ${tail.totalLines} retained`);
    assert.ok(absorbed(), 'all output should arrive');
    assert.ok(tail.evictedLines > 0, 'the buffer cap should have evicted lines');
    assert.ok(absorbMs < MAX_ABSORB_MS,
      `evicting ${tail.evictedLines} lines should not stall the server: took ${absorbMs}ms (limit ${MAX_ABSORB_MS}ms)`);
    console.log('ok: overflow absorbed without stalling');
  } finally {
    await forceTerminate({ pid });
  }
}

runIfMain(import.meta.url, testOverflowAbsorbedQuickly);

export default testOverflowAbsorbedQuickly;
