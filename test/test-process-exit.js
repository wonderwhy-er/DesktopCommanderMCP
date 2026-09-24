/**
 * How the process tools report a process's output and its end:
 * - output written after the process exits stays readable
 *
 * The tools run in-process, so their structuredContent (kept internal, never
 * sent to a client) is read directly. The processes are the modes of
 * fixtures/process-exit.js.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { startProcess, readProcessOutput } from '../dist/tools/improved-process-tools.js';
import { terminalManager } from '../dist/terminal-manager.js';
import { runIfMain } from './helpers/run-if-main.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'process-exit.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (result) => result.content[0].text;
const exited = (pid) => terminalManager.getSession(pid) === undefined;

/** The shell command running the fixture in `mode`, quoted for PowerShell, cmd and POSIX shells */
const fixture = (mode, ...args) => ['node', `"${FIXTURE}"`, mode, ...args.map((arg) => `"${arg}"`)].join(' ');

const triggerDirs = [];
/** A file path a fixture waits for; pull() creates it */
function newTrigger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-process-exit-'));
  triggerDirs.push(dir);
  return path.join(dir, 'go');
}
const pull = (trigger) => fs.writeFileSync(trigger, '');

async function waitUntil(condition, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting until ${what}`);
    await sleep(50);
  }
}

function check(ok, message) {
  if (!ok) throw new Error(message);
}

async function start(command, timeoutMs) {
  const result = await startProcess({ command, timeout_ms: timeoutMs });
  const pid = result.structuredContent?.pid;
  check(pid > 0, `start_process should start "${command}", got: ${text(result)}`);
  return { pid, reply: text(result), status: result.structuredContent.status };
}

async function testOutputAfterExitIsReadable() {
  const trigger = newTrigger();
  const { pid } = await start(fixture('late-writer', trigger), 10_000);
  await waitUntil(() => exited(pid), 10_000, 'the process exits');
  pull(trigger);  // only now does the process it left behind write
  let seen = '';
  let last = '';
  for (const deadline = Date.now() + 5_000; !seen.includes('written after the exit') && Date.now() < deadline;) {
    last = text(await readProcessOutput({ pid, timeout_ms: 200 }));
    seen += last;
    await sleep(100);
  }
  check(seen.includes('written after the exit'),
    `output written after the process exited should be readable within 5s, the last read returned: ${JSON.stringify(last)}`);
}

const CASES = [
  ['output written after the exit is readable', testOutputAfterExitIsReadable],
];

async function runTests() {
  const failures = [];
  for (const [name, run] of CASES) {
    console.log(`\n--- ${name} ---`);
    try {
      await run();
      console.log('ok');
    } catch (error) {
      failures.push(name);
      console.log(`❌ ${error.message}`);
    }
  }
  for (const dir of triggerDirs) {
    // Best-effort: a trigger dir left in the temp folder is harmless
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(failures.length === 0
    ? '\n✅ process exit tests passed'
    : `\n❌ ${failures.length} of ${CASES.length} failed: ${failures.join('; ')}`);
  return failures.length === 0;
}

runIfMain(import.meta.url, runTests);

export default runTests;
