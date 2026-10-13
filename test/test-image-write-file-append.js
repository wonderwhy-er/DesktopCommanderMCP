/**
 * write_file with mode "append" on an existing image must not replace it.
 *
 * The image handler ignored the mode: it base64-decoded the new content and
 * wrote it over the file, answering "Successfully appended", so a 68-byte PNG
 * became 6 garbage bytes. An image can't take text at its end; the call must
 * refuse, as it does for DOCX and PDF, and leave the file as it was.
 * Runs the real server over stdio, as a client does.
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runIfMain } from './helpers/run-if-main.js';
import { closeClient } from './helpers/close-client.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6p6xkAAAAASUVORK5CYII=', 'base64');

export default async function runTests() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-image-append-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(PROJECT_ROOT, 'dist/index.js'), '--no-onboarding'],
    cwd: PROJECT_ROOT,
    stderr: 'pipe',
    env: { ...process.env },
  });
  const client = new Client({ name: 'image-append-test', version: '1.0.0' }, { capabilities: {} });
  const failures = [];
  try {
    await client.connect(transport, { timeout: 30_000 });
    const image = path.join(dir, 'picture.png');
    fs.writeFileSync(image, TINY_PNG);
    const result = await client.callTool({ name: 'write_file', arguments: { path: image, content: 'more text', mode: 'append' } });
    const text = result.content?.[0]?.text ?? '';
    const after = fs.readFileSync(image);
    for (const [name, check] of [
      ['the image is left as it was', () => assert(after.equals(TINY_PNG),
        `write_file with mode "append" on a ${TINY_PNG.length}-byte PNG answered "${text}", and the file now holds ${after.length} bytes (${JSON.stringify(after.toString('latin1').slice(0, 20))})`)],
      ['the call is refused', () => assert(result.isError && /Image append not supported/.test(text),
        `write_file with mode "append" on a PNG should refuse ("Image append not supported."), answered: ${text}`)],
    ]) {
      try {
        check();
        console.log(`✓ write_file append on a PNG: ${name}`);
      } catch (error) {
        failures.push(error);
        console.error(`✗ write_file append on a PNG: ${error.message}`);
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
