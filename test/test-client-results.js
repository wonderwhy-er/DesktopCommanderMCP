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
    for (const check of [writePdfIgnoringAnOption]) {
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
