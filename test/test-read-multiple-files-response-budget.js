#!/usr/bin/env node

import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const TEST_DIR = path.join(__dirname, 'test_read_multiple_response_budget');
const TEST_HOME = path.join(TEST_DIR, 'home');
const CANARY = path.join(TEST_DIR, 'canary.txt');

async function callTool(client, name, args) {
  return client.callTool(
    { name, arguments: args },
    undefined,
    { timeout: 120000 }
  );
}

function textOf(result) {
  return result?.content?.find?.((item) => item.type === 'text')?.text ?? '';
}
function deterministicRgb(width, height, seed) {
  const output = Buffer.alloc(width * height * 3);
  let value = (0x9e3779b9 ^ seed) >>> 0;
  for (let i = 0; i < output.length; i++) {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    output[i] = value & 255;
  }
  return output;
}

async function createNoisePng(filePath, seed) {
  const width = 1024;
  const height = 1024;
  await sharp(deterministicRgb(width, height, seed), {
    raw: { width, height, channels: 3 }
  }).png({ compressionLevel: 0 }).toFile(filePath);
}

async function createImagePdf(filePath, pngPath, pageCount) {
  const pngBytes = await fs.readFile(pngPath);
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    const image = await pdf.embedPng(pngBytes);
    const page = pdf.addPage([1024, 1024]);
    page.drawImage(image, { x: 0, y: 0, width: 1024, height: 1024 });
  }
  await fs.writeFile(filePath, await pdf.save({ useObjectStreams: false }));
}
async function createClient() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(PROJECT_ROOT, 'dist', 'index.js'), '--no-onboarding'],
    cwd: PROJECT_ROOT,
    stderr: 'pipe',
    env: {
      ...process.env,
      HOME: TEST_HOME,
      USERPROFILE: TEST_HOME,
      DESKTOP_COMMANDER_DISABLE_TELEMETRY: 'true'
    }
  });
  const client = new Client(
    { name: 'read-multiple-response-budget-test', version: '1.0.0' },
    { capabilities: {} }
  );
  await client.connect(transport, { timeout: 30000 });
  return client;
}

function assertBudgetError(result, label) {
  assert.equal(result.isError, true, `${label} should return a recoverable tool error`);
  assert.match(textOf(result), /safe aggregate limit/i);
  assert.match(textOf(result), /Read fewer files or PDF pages per request/i);
  assert.ok(
    Buffer.byteLength(JSON.stringify(result), 'utf8') < 1024 * 1024,
    `${label} error response itself should stay small`
  );
}
async function assertConnectionAlive(client, label) {
  const result = await callTool(client, 'read_file', { path: CANARY });
  assert.notEqual(result.isError, true, `${label}: follow-up read_file should succeed`);
  assert.match(textOf(result), /connection-alive/);
}

await fs.rm(TEST_DIR, { recursive: true, force: true });
await fs.mkdir(TEST_HOME, { recursive: true });
await fs.writeFile(CANARY, 'connection-alive');

const pngPaths = [1, 2, 3].map((n) => path.join(TEST_DIR, `noise-${n}.png`));
for (let i = 0; i < pngPaths.length; i++) {
  await createNoisePng(pngPaths[i], i + 1);
}
const pdfPath = path.join(TEST_DIR, 'noise-11p.pdf');
await createImagePdf(pdfPath, pngPaths[0], 11);

// 5.3M copies of é are 5.3M JavaScript characters but 10.6M UTF-8 bytes.
// This proves the response budget is byte-based rather than character-based.
const multibytePath = path.join(TEST_DIR, 'multibyte.txt');
const multibyteText = '\u00e9'.repeat(5_300_000);
assert.ok(multibyteText.length < 9.5 * 1024 * 1024);
assert.ok(Buffer.byteLength(multibyteText, 'utf8') > 10 * 1024 * 1024);
await fs.writeFile(multibytePath, multibyteText, 'utf8');

const client = await createClient();
try {
  const small = await callTool(client, 'read_multiple_files', {
    paths: pngPaths.slice(0, 2)
  });
  assert.notEqual(small.isError, true, 'small direct-image batch should remain unchanged');
  assert.equal(
    small.content.filter((item) => item.type === 'image').length,
    2,
    'small direct-image batch should return both images'
  );

  // Unknown keys are normally surfaced in a dispatcher warning. A very large
  // key can push an otherwise-safe image response over the transport budget,
  // so read_multiple_files must recheck after that warning is added.
  const oversizedAfterWarning = await callTool(client, 'read_multiple_files', {
    paths: pngPaths.slice(0, 2),
    ['x'.repeat(2 * 1024 * 1024)]: true
  });
  assertBudgetError(oversizedAfterWarning, 'post-warning oversized batch');
  await assertConnectionAlive(client, 'after post-warning rejection');
  console.log('✓ dispatcher warning growth is included in the aggregate budget');

  const oversizedMultibyte = await callTool(client, 'read_multiple_files', {
    paths: [multibytePath]
  });
  assertBudgetError(oversizedMultibyte, 'oversized multibyte text batch');
  await assertConnectionAlive(client, 'after multibyte rejection');
  console.log('✓ aggregate budget is enforced in UTF-8 bytes, not JavaScript characters');

  const oversizedDirect = await callTool(client, 'read_multiple_files', {
    paths: pngPaths
  });
  assertBudgetError(oversizedDirect, 'oversized direct-image batch');
  await assertConnectionAlive(client, 'after direct-image rejection');

  const oversizedPdf = await callTool(client, 'read_multiple_files', {
    paths: [pdfPath]
  });
  assertBudgetError(oversizedPdf, 'oversized PDF-image batch');
  await assertConnectionAlive(client, 'after PDF-image rejection');

  console.log('✓ read_multiple_files aggregate budget rejects oversized image/PDF responses');
  console.log('✓ MCP connection remains usable after all recoverable rejections');
} finally {
  try { await client.close(); } catch {}
  await fs.rm(TEST_DIR, { recursive: true, force: true });
}
