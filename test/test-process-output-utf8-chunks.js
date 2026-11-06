/**
 * Regression test for #628: UTF-8 code points split across multiple child
 * stdout/stderr chunks must be decoded as one character, not replacement chars.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TerminalManager, terminalManager } from '../dist/terminal-manager.js';
import { runIfMain } from './helpers/run-if-main.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

const EXPECTED = '\u2264';
const REPLACEMENT = '\uFFFD';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runOne(streamName, ownedRoot) {
  const scriptPath = path.join(ownedRoot, `${streamName}.mjs`);
  fs.writeFileSync(scriptPath, `
const stream = process.${streamName};
stream.write(Buffer.from([0xE2]));
setTimeout(() => stream.write(Buffer.from([0x89])), 60);
setTimeout(() => stream.write(Buffer.from([0xA4])), 120);
setTimeout(() => stream.write('\\n'), 180);
setTimeout(() => process.exit(0), 240);
`);

  const result = await terminalManager.executeCommand(`node ${JSON.stringify(scriptPath)}`, 5000);
  let combined = result.output;
  for (let attempt = 0; attempt < 200 && !combined.includes(EXPECTED); attempt++) {
    await sleep(50);
    const retained = terminalManager.readOutputPaginated(result.pid, 0, 100);
    const retainedText = retained?.lines?.join('\n') ?? '';
    combined = `${result.output}\n${retainedText}`;
  }

  assert.ok(combined.includes(EXPECTED), `${streamName} should preserve the split UTF-8 character; got ${JSON.stringify(combined)}`);
  assert.ok(!combined.includes(REPLACEMENT), `${streamName} should not contain replacement characters; got ${JSON.stringify(combined)}`);
  console.log(`PASS: ${streamName} preserves a split UTF-8 sequence`);
}

async function runEmptyDecodedChunkStateTest() {
  const manager = new TerminalManager();
  const pid = 628001;
  const session = {
    outputLines: [],
    bufferedChars: 0,
    evictedLines: 0,
    evictedChars: 0,
    streams: {
      stdout: { text: '', chars: 0, turn: 0 },
      stderr: { text: '', chars: 0, turn: 0 }
    }
  };

  manager.sessions.set(pid, session);
  try {
    manager.recordOutput(session, 'stderr', 'background\n');
    await new Promise((resolve) => setImmediate(resolve));
    manager.recordOutput(session, 'stdout', '> ');
    await new Promise((resolve) => setImmediate(resolve));

    const stderrTurnBeforeEmptyChunk = session.streams.stderr.turn;
    manager.recordOutput(session, 'stderr', '');

    assert.equal(
      session.streams.stderr.turn,
      stderrTurnBeforeEmptyChunk,
      'an empty decoded chunk must not advance its stream delivery turn'
    );
    const state = manager.getProcessState(pid);
    assert.equal(
      state?.isWaitingForInput,
      true,
      `an empty decoded stderr chunk must not supersede the newer stdout prompt; got ${JSON.stringify(state)}`
    );
    console.log('PASS: empty decoded chunks do not advance process-state delivery order');
  } finally {
    manager.sessions.delete(pid);
  }
}
async function runTests() {
  const ownedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-utf8-process-output-'));
  try {
    await runOne('stdout', ownedRoot);
    await runOne('stderr', ownedRoot);
    await runEmptyDecodedChunkStateTest();
    console.log('PASS: split UTF-8 process output is decoded correctly');
  } finally {
    fs.rmSync(ownedRoot, { recursive: true, force: true });
  }
}

runIfMain(import.meta.url, runTests);
