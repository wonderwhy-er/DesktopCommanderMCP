/**
 * #397: start_process sends initial stdin as exact text and closes its stdin
 * only when explicitly supplied. This covers PowerShell-hostile characters,
 * Unicode, multiline content, and the distinction between absent and empty input.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StartProcessArgsSchema } from '../dist/tools/schemas.js';
import { startProcess, readProcessOutput, forceTerminate } from '../dist/tools/improved-process-tools.js';
import { terminalManager } from '../dist/terminal-manager.js';
import { runIfMain } from './helpers/run-if-main.js';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'start-process-stdin.js');
const command = `node "${file}"`;
const marker = 'STDIN_BASE64=';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runAndRead(input) {
  let pid;
  try {
    const result = await startProcess({ command, stdin: input, timeout_ms: 4000 }, 4000);
    assert.equal(result.isError, undefined, result.content[0]?.text);
    pid = result.structuredContent?.pid;
    assert(pid > 0, 'start_process should return a real process PID');

    let output = result.content[0]?.text ?? '';
    const deadline = Date.now() + 5000;
    while (!output.includes(marker) && Date.now() < deadline) {
      const next = await readProcessOutput({ pid, timeout_ms: 500 });
      output += next.content[0]?.text ?? '';
      if (!output.includes(marker)) await sleep(60);
    }
    assert(output.includes(marker), `expected child to read stdin and reach EOF, received: ${output}`);
    const encoded = output.slice(output.indexOf(marker) + marker.length).split(/\r?\n/)[0].trim();
    assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), input);
    if (input.length > 0) {
      assert(!result.content[0].text.includes(input), 'initial result should not echo raw stdin');
    }
  } finally {
    if (pid && terminalManager.getSession(pid)) await forceTerminate({ pid });
  }
}

async function testMissingStdinRemainsInteractive() {
  let pid;
  try {
    const result = await startProcess({ command, timeout_ms: 400 }, 400);
    pid = result.structuredContent?.pid;
    assert(pid > 0);
    const session = terminalManager.getSession(pid);
    assert(session && !session.process.stdin.writableEnded,
      'omitting stdin must preserve the existing interactive input channel');
  } finally {
    if (pid && terminalManager.getSession(pid)) await forceTerminate({ pid });
  }
}

export default async function runTests() {
  const payload = 'first line\n"double quote" \'single quote\' `backtick` $env:PATH € Türkçe 🐙\nlast line\n';
  const parsed = StartProcessArgsSchema.parse({ command, stdin: payload, timeout_ms: 4000 });
  assert.equal(parsed.stdin, payload, 'schema must retain explicitly supplied stdin');
  assert.equal(StartProcessArgsSchema.safeParse({ command, stdin: 22, timeout_ms: 4000 }).success, false,
    'stdin must be a string');

  const virtual = await startProcess({ command: 'node:local', stdin: 'text', timeout_ms: 4000 });
  assert.equal(virtual.isError, true, 'node:local must reject stdin rather than discard it');

  await runAndRead(payload);
  await runAndRead('');
  await testMissingStdinRemainsInteractive();
  console.log('PASS: #397 exact stdin, empty stdin, schema, and omitted-stdin compatibility');
  return true;
}

runIfMain(import.meta.url, runTests);
