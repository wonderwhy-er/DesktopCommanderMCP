/**
 * An SVG is text (XML). read_file and read_multiple_files list the images they
 * show as images (PNG, JPEG, GIF, WebP), but the file handlers took every .svg
 * for an image: read_file answered an image block instead of the SVG's text,
 * and write_file and edit_block base64-decoded the text they were given, so a
 * 41-character SVG became 6 garbage bytes, with "Successfully wrote".
 *
 * Expected: the tools read and write an .svg as the text it is. The file
 * preview widget still draws an SVG as an image: its own read (origin 'ui')
 * gets the file's bytes as base64, as before.
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
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>';

const textOf = (result) => (result.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('\n');
const blockTypes = (result) => JSON.stringify((result.content ?? []).map((block) => block.type));

async function readFileAnswersTheText(client, dir) {
  const file = path.join(dir, 'read.svg');
  fs.writeFileSync(file, SVG);
  const result = await client.callTool({ name: 'read_file', arguments: { path: file } });
  assert(!result.content?.some((block) => block.type === 'image'),
    `read_file of a text .svg answered an image block instead of its text (blocks: ${blockTypes(result)})`);
  assert(textOf(result).includes(SVG), `read_file of a text .svg did not answer its text: ${textOf(result).slice(0, 200)}`);
}

async function readMultipleFilesAnswersTheText(client, dir) {
  const file = path.join(dir, 'multi.svg');
  fs.writeFileSync(file, SVG);
  const result = await client.callTool({ name: 'read_multiple_files', arguments: { paths: [file] } });
  assert(!result.content?.some((block) => block.type === 'image'),
    `read_multiple_files of a text .svg answered an image block instead of its text (blocks: ${blockTypes(result)})`);
  assert(textOf(result).includes(SVG), `read_multiple_files of a text .svg did not answer its text: ${textOf(result).slice(0, 200)}`);
}

async function writeFileWritesTheText(client, dir) {
  const file = path.join(dir, 'write.svg');
  const result = await client.callTool({ name: 'write_file', arguments: { path: file, content: SVG, mode: 'rewrite' } });
  const written = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
  assert.strictEqual(written.toString('utf8'), SVG,
    `write_file answered "${textOf(result).split('\n')[0]}", but the .svg holds ${written.length} bytes (${JSON.stringify(written.toString('latin1'))}) instead of the ${SVG.length} characters sent`);
}

async function editBlockWritesTheText(client, dir) {
  const file = path.join(dir, 'edit.svg');
  fs.writeFileSync(file, SVG);
  const result = await client.callTool({ name: 'edit_block', arguments: { file_path: file, old_string: '<rect', new_string: '<rect x="0"' } });
  const edited = fs.readFileSync(file);
  assert.strictEqual(edited.toString('utf8'), SVG.replace('<rect', '<rect x="0"'),
    `edit_block answered "${textOf(result).split('\n')[0]}", but the .svg holds ${edited.length} bytes (${JSON.stringify(edited.toString('latin1'))}) instead of the edited text`);
}

async function previewWidgetStillGetsTheImage(client, dir) {
  const file = path.join(dir, 'preview.svg');
  fs.writeFileSync(file, SVG);
  const result = await client.callTool({ name: 'read_file', arguments: { path: file, origin: 'ui' } });
  assert.strictEqual(result.structuredContent?.fileType, 'image', `the preview widget's read of an .svg should draw it as an image, got fileType ${result.structuredContent?.fileType}`);
  assert.strictEqual(result.structuredContent?.mimeType, 'image/svg+xml', `the preview widget's read of an .svg should say image/svg+xml, got ${result.structuredContent?.mimeType}`);
  assert.strictEqual(textOf(result), Buffer.from(SVG).toString('base64'), `the preview widget's read of an .svg should carry the file as base64, got ${textOf(result).slice(0, 200)}`);
}

export default async function runTests() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-svg-text-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(PROJECT_ROOT, 'dist/index.js'), '--no-onboarding'],
    cwd: PROJECT_ROOT,
    stderr: 'pipe',
    env: { ...process.env },
  });
  const client = new Client({ name: 'svg-text-test', version: '1.0.0' }, { capabilities: {} });
  const failures = [];
  try {
    await client.connect(transport, { timeout: 30_000 });
    for (const check of [readFileAnswersTheText, readMultipleFilesAnswersTheText, writeFileWritesTheText, editBlockWritesTheText, previewWidgetStillGetsTheImage]) {
      try {
        await check(client, dir);
        console.log(`✓ ${check.name}`);
      } catch (error) {
        failures.push(error);
        console.error(`✗ ${check.name}: ${error.message}`);
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
