/**
 * What a client receives from the tools the stack's fixes touched: exactly
 * what it received before. Facts those fixes added for Desktop Commander's own
 * code and tests (structuredContent) are dropped before the reply
 * (src/utils/internal-facts.ts), so no new information reaches the client.
 * Runs the real server over stdio, as a client does.
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runIfMain, skip } from './helpers/run-if-main.js';
import { closeClient } from './helpers/close-client.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const textOf = (result) => result.content?.find((block) => block.type === 'text')?.text ?? '';

/** write_pdf with an option Desktop Commander ignores: the answer is the plain success line */
async function writePdfIgnoringAnOption(client, dir) {
  const target = path.join(dir, 'ignored-option.pdf');
  const result = await client.callTool({
    name: 'write_pdf',
    arguments: { path: target, content: '# Client results\n', options: { devtools: true } },
  });
  if (/requires Chrome or Chromium/.test(textOf(result))) {
    skip(`write_pdf: no Chrome to render with (${textOf(result)})`);
    return;
  }
  assert.strictEqual(textOf(result), `Successfully wrote PDF to ${target}`, 'write_pdf should answer as before');
  assert.strictEqual(result.structuredContent, undefined,
    `write_pdf should send no structuredContent, got ${JSON.stringify(result.structuredContent)}`);
  console.log('✓ write_pdf: the answer is the same as before, nothing internal is sent');
}

function assertNothingInternal(tool, result) {
  assert.strictEqual(result.structuredContent, undefined,
    `${tool} should send no structuredContent, got ${JSON.stringify(result.structuredContent)}`);
}

/** start_process (finished, blocked), interact_with_process and list_sessions send only their text */
async function processToolsSendOnlyText(client) {
  const finished = await client.callTool({
    name: 'start_process',
    arguments: { command: 'node -e "console.log(1)"', timeout_ms: 10000 },
  });
  assert.match(textOf(finished), /^Process started with PID \d+/, `start_process should start node, got: ${textOf(finished)}`);
  assertNothingInternal('start_process', finished);

  const blocked = await client.callTool({ name: 'start_process', arguments: { command: 'mkfs', timeout_ms: 1000 } });
  assert.strictEqual(textOf(blocked), 'Error: Command not allowed: mkfs', 'a blocked command should answer as before');
  assertNothingInternal('start_process (blocked command)', blocked);

  const repl = await client.callTool({ name: 'start_process', arguments: { command: 'node -i', timeout_ms: 5000 } });
  const pid = Number(textOf(repl).match(/PID (\d+)/)?.[1]);
  assert(pid, `start_process should start the Node.js REPL, got: ${textOf(repl)}`);
  try {
    assertNothingInternal('start_process (REPL)', repl);
    const interacted = await client.callTool({
      name: 'interact_with_process',
      arguments: { pid, input: 'console.log(6 * 7)', timeout_ms: 5000 },
    });
    assert.match(textOf(interacted), /^✅ Input executed in process/, `interact_with_process should run the input, got: ${textOf(interacted)}`);
    assertNothingInternal('interact_with_process', interacted);

    const sessions = await client.callTool({ name: 'list_sessions', arguments: {} });
    assert.match(textOf(sessions), new RegExp(`PID: ${pid}`), `list_sessions should list the REPL, got: ${textOf(sessions)}`);
    assertNothingInternal('list_sessions', sessions);
  } finally {
    await client.callTool({ name: 'force_terminate', arguments: { pid } });
  }
  console.log('✓ start_process, interact_with_process, list_sessions: nothing internal is sent');
}

/** start_search and get_more_search_results send only their text */
async function searchToolsSendOnlyText(client, dir) {
  fs.writeFileSync(path.join(dir, 'needle.txt'), 'a needle in the file\n');
  const started = await client.callTool({
    name: 'start_search',
    arguments: { path: dir, pattern: 'needle', searchType: 'content' },
  });
  const sessionId = textOf(started).match(/session: (\S+)/)?.[1];
  assert(sessionId, `start_search should start a session, got: ${textOf(started)}`);
  try {
    assertNothingInternal('start_search', started);
    const page = await client.callTool({ name: 'get_more_search_results', arguments: { sessionId } });
    assert(!page.isError, `get_more_search_results should answer, got: ${textOf(page)}`);
    assertNothingInternal('get_more_search_results', page);
  } finally {
    await client.callTool({ name: 'stop_search', arguments: { sessionId } });
  }
  console.log('✓ start_search, get_more_search_results: nothing internal is sent');
}

export default async function runTests() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-client-results-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(PROJECT_ROOT, 'dist/index.js'), '--no-onboarding'],
    cwd: PROJECT_ROOT,
    stderr: 'pipe',
    env: { ...process.env },
  });
  const client = new Client({ name: 'client-results-test', version: '1.0.0' }, { capabilities: {} });
  const failures = [];
  try {
    await client.connect(transport, { timeout: 30_000 });
    for (const check of [writePdfIgnoringAnOption, processToolsSendOnlyText, searchToolsSendOnlyText]) {
      try {
        await check(client, dir);
      } catch (error) {
        failures.push(error);
        console.error(`✗ ${error.message}`);
      }
    }
  } finally {
    await closeClient(client);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  assert.deepStrictEqual(failures.map((error) => error.message), [], `${failures.length} check(s) failed`);
  return true;
}

runIfMain(import.meta.url, runTests);
