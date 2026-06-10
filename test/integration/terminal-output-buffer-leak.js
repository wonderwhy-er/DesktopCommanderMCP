/**
 * Regression test: TerminalManager output buffering must stay bounded.
 *
 * Root cause (fixed):
 *   executeCommand() accumulated process output into unbounded strings
 *   (`output += text` in the data handlers, plus session.outputLines), and
 *   kept accumulating even after the call resolved. A process emitting more
 *   than V8's max string length (~536M chars) made concatenation throw
 *   "RangeError: Invalid string length" inside a 'data' handler ->
 *   uncaughtException -> the whole MCP server (shared by every chat) died
 *   silently, and every command failed until restart. Reported as the
 *   "Invalid string length" / "freezing in multiple chats" bugs.
 *
 * Fix (terminal-manager.ts):
 *   Per-session buffer cap (evict-oldest), force-splitting of single lines,
 *   bounded sliding tail for the wait-phase buffer, eviction-aware
 *   snapshot offsets.
 *
 * This test drives the real built TerminalManager in-process (no MCP
 * transport) with a finite ~600MB flood that keeps streaming AFTER
 * executeCommand has already returned — the cross-chat leak scenario.
 * On unfixed code it crashes with "Invalid string length"; on fixed code
 * it asserts:
 *   1. the buffer stays bounded and eviction actually happened
 *   2. the event loop never stalls badly while the flood streams
 *   3. the output tail (end marker) is still readable after eviction
 *   4. snapshot reads work across eviction without throwing
 *
 * Run:  node test/integration/terminal-output-buffer-leak.js
 */

import assert from 'assert';
import { performance } from 'perf_hooks';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = 'true';

const { terminalManager } = await import('../../dist/terminal-manager.js');

// Must match MAX_BUFFERED_OUTPUT_CHARS in terminal-manager.ts, with slack for
// one in-flight chunk and force-split separators.
const BUFFER_CAP_CHARS = 50 * 1024 * 1024;
const BUFFER_CAP_SLACK = 2 * 1024 * 1024;

// 8MB x 72 = ~604MB on one line — past V8's ~536M char limit that used to
// crash the process — then a newline-delimited end marker.
const FLOOD_CHUNK_CHARS = 8 * 1024 * 1024;
const FLOOD_CHUNKS = 72;
const END_MARKER = 'FLOOD_END_MARKER';

const MAX_EVENT_LOOP_STALL_MS = 500;
const FLOOD_DEADLINE_MS = 90000;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  console.log('===== terminal output buffer cap regression test =====');
  const floodCmd = `node -e "const s='x'.repeat(${FLOOD_CHUNK_CHARS}); for(let i=0;i<${FLOOD_CHUNKS};i++) process.stdout.write(s); process.stdout.write('\\n${END_MARKER}\\n');"`;

  // Return after 500ms while the flood keeps streaming — the leak scenario:
  // output nobody is reading, accumulating inside the long-lived server.
  const result = await terminalManager.executeCommand(floodCmd, 500);
  assert.ok(result.pid > 0, 'executeCommand should return a valid pid');
  const session = terminalManager.getSession(result.pid);
  assert.ok(session, 'session should still exist after the call returned');

  // Take a snapshot now; eviction will discard most output between snapshot
  // and the read below — the read must degrade gracefully, not throw.
  const snapshot = terminalManager.captureOutputSnapshot(result.pid);
  assert.ok(snapshot, 'snapshot should be available');

  // Watch the flood stream in, sampling event-loop lag.
  let maxStallMs = 0;
  const startedAt = performance.now();
  let exitCode = null;
  session.process.on('exit', (code) => { exitCode = code ?? 0; });
  while (exitCode === null && performance.now() - startedAt < FLOOD_DEADLINE_MS) {
    const t = performance.now();
    await sleep(50);
    maxStallMs = Math.max(maxStallMs, performance.now() - t - 50);
  }
  assert.notStrictEqual(exitCode, null, `flood should finish within ${FLOOD_DEADLINE_MS}ms`);

  // 1. Buffer bounded + eviction happened (the fix at work).
  const completedTail = terminalManager.readOutputPaginated(result.pid, -5, 5);
  assert.ok(completedTail, 'should be able to read output after completion');
  const joinedLength = completedTail.totalLines <= 0 ? 0
    : terminalManager.getOutputSinceSnapshot(result.pid, { totalChars: 0, lineCount: 0 })?.length ?? 0;
  assert.ok(
    joinedLength <= BUFFER_CAP_CHARS + BUFFER_CAP_SLACK,
    `retained output ${joinedLength} chars should be within the ${BUFFER_CAP_CHARS} cap (+slack)`
  );
  assert.ok(joinedLength > 0, 'some output should be retained');

  // 2. Event loop stayed healthy while ~600MB streamed through the handlers.
  assert.ok(
    maxStallMs < MAX_EVENT_LOOP_STALL_MS,
    `event loop stalled ${maxStallMs.toFixed(0)}ms during the flood (limit ${MAX_EVENT_LOOP_STALL_MS}ms)`
  );

  // 3. The most recent output survived eviction.
  assert.ok(
    completedTail.lines.join('\n').includes(END_MARKER),
    'end marker should be readable in the retained tail'
  );

  // 4. Snapshot read across heavy eviction degrades gracefully (returns the
  //    retained tail) instead of throwing or returning garbage offsets.
  const sinceSnapshot = terminalManager.getOutputSinceSnapshot(result.pid, snapshot);
  assert.ok(typeof sinceSnapshot === 'string', 'snapshot read should return a string');
  assert.ok(sinceSnapshot.includes(END_MARKER), 'snapshot read should include the newest output');

  const totalEmittedMB = Math.round((FLOOD_CHUNK_CHARS * FLOOD_CHUNKS) / 1024 / 1024);
  console.log(`flood: ${totalEmittedMB} MB emitted, ${(joinedLength / 1024 / 1024).toFixed(1)} MB retained (cap ${BUFFER_CAP_CHARS / 1024 / 1024} MB)`);
  console.log(`max event-loop stall: ${maxStallMs.toFixed(0)}ms | exit code: ${exitCode}`);
  console.log('PASS — output buffer stayed bounded, server-side state healthy throughout.');
  process.exit(0);
}

main().catch((err) => {
  // On unfixed code the flood itself crashes here ("Invalid string length").
  console.error('FAIL:', err.message);
  process.exit(1);
});
