import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startProcess, readProcessOutput, interactWithProcess, forceTerminate } from '../dist/tools/improved-process-tools.js';
import { terminalManager } from '../dist/terminal-manager.js';
import { processLifecycle } from '../dist/process-lifecycle.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function script(code) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-finite-'));
  const file = path.join(dir, 'command.cjs');
  await fs.writeFile(file, code);
  return { command: '"' + process.execPath + '" "' + file + '"', cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}
async function finished(pid) {
  const deadline = Date.now() + 10000;
  while (terminalManager.getSession(pid) && Date.now() < deadline) await pause(50);
  assert.equal(terminalManager.getSession(pid), undefined, 'command must reach a terminal state');
  return terminalManager.getLifecycle(pid);
}
async function run(code, options, check) {
  const input = await script(code);
  let pid;
  try {
    const result = await startProcess({ command: input.command, timeout_ms: 5000, ...options });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    pid = result.structuredContent.pid;
    await check(result, pid);
  } finally { if (pid) await forceTerminate({ pid }); await input.cleanup(); }
}

test('finite default closes stdin and completes an EOF reader', async () => {
  await run("process.stdin.resume(); process.stdin.on('end', () => console.log('EOF received'));", {}, async (result, pid) => {
    const receipt = await finished(pid);
    const output = await readProcessOutput({ pid, offset: -10 });
    assert.match(output.content[0].text, /EOF received/);
    assert.equal(receipt.mode, 'finite');
    assert.equal(receipt.reason, 'exited');
    assert.equal(receipt.cleanupComplete, true);
  });
});

test('deadline persists after initial wait and repeated output polls', async () => {
  await run("console.log('started'); setInterval(() => {}, 1000);", { timeout_ms: 20, max_duration_ms: 800 }, async (result, pid) => {
    for (let i = 0; i < 3; i++) await readProcessOutput({ pid, timeout_ms: 30 });
    const receipt = await finished(pid);
    assert.equal(receipt.reason, 'duration_limit');
    assert.equal(receipt.cleanupComplete, true);
    const output = await readProcessOutput({ pid, offset: -5 });
    assert.equal(output.structuredContent.lifecycle.reason, 'duration_limit');
    assert.match(output.content[0].text, /duration_limit/);
  });
});

for (const stream of ['stdout', 'stderr']) test(stream + ' UTF-8 bytes exhaust the output budget and end the process', async () => {
  await run("setInterval(() => process." + stream + ".write('雪'.repeat(1000)), 1);", { max_output_bytes: 1024 }, async (result, pid) => {
    const receipt = await finished(pid);
    assert.equal(receipt.reason, 'output_limit');
    assert(receipt.outputBytes >= 1024);
    assert.equal(receipt.cleanupComplete, true);
    const output = await readProcessOutput({ pid, offset: -10 });
    assert.match(output.content[0].text, /output_limit/);
  });
});

test('combined streams share one byte budget', async () => {
  await run("process.stdout.write('a'.repeat(600)); process.stderr.write('b'.repeat(600)); setInterval(() => {}, 1000);", { max_output_bytes: 1000 }, async (result, pid) => {
    assert.equal((await finished(pid)).reason, 'output_limit');
  });
});

test('finite POSIX shell exit cleans up background descendants', { skip: process.platform === 'win32' }, async () => {
  await run("const c=require('child_process').spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'}); console.log('child='+c.pid); c.unref();", {}, async (result, pid) => {
    assert.equal((await finished(pid)).cleanupComplete, true);
    const output = (await readProcessOutput({ pid, offset: -5 })).content[0].text;
    const child = Number(output.match(/child=(\d+)/)?.[1]);
    assert(child > 0, output);
    assert.throws(() => process.kill(child, 0), { code: 'ESRCH' });
  });
});

test('explicit interactive Node REPL retains stdin across tool calls', async () => {
  const result = await startProcess({ command: '"' + process.execPath + '" -i', mode: 'interactive', timeout_ms: 3000 });
  const pid = result.structuredContent.pid;
  try {
    assert.equal(result.structuredContent.lifecycle.mode, 'interactive');
    await interactWithProcess({ pid, input: 'var lifecycleValue = 21', timeout_ms: 1000 });
    const response = await interactWithProcess({ pid, input: 'lifecycleValue * 2', timeout_ms: 1000 });
    assert.match(response.content[0].text, /42/);
    assert(terminalManager.getSession(pid));
  } finally { await forceTerminate({ pid }); }
});

test('invalid budgets and interactive finite-budget combinations are rejected', async () => {
  for (const opts of [{max_duration_ms:0}, {max_duration_ms:Infinity}, {max_output_bytes:-1}, {max_output_bytes:67108865}, {mode:'interactive',max_duration_ms:1}]) {
    assert.throws(() => processLifecycle(opts));
    const response = await startProcess({command:'echo should-not-run',timeout_ms:10,...opts});
    assert.equal(response.isError, true);
  }
});
