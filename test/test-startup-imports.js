/**
 * Starting the server must not load the packages only Excel, PDF and DOCX
 * files need (#715). Every launch loaded them before answering `initialize`,
 * whether or not the session ever opened such a file: 1,183 of the 1,556
 * modules loaded before the answer, which one reporter saw take 25-90 s and
 * time the client out. Each package still loads the first time a file needs it.
 *
 * Starts the real server (dist/index.js) over MCP stdio, the way a client
 * does, recording every module it resolves (import and require).
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { HEAVY_PACKAGES, packageOf, startServerRecordingModules } from './helpers/server-modules.js';
import { isTestHome } from './helpers/test-env.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_PDF = path.join(PROJECT_ROOT, 'test/samples/01_sample_simple.pdf');
const WARM_UP_TIMEOUT_MS = 60_000;

const heavyLoaded = (modules) => HEAVY_PACKAGES.filter((pkg) => modules.some((module) => packageOf(module.url) === pkg));

function text(result) {
  return (result.content ?? []).map((item) => item.text ?? '').join('\n');
}

async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.notStrictEqual(result.isError, true, `${name} ${JSON.stringify(args)} failed: ${text(result)}`);
  return text(result);
}

/** Nothing for Excel, PDF or DOCX files is loaded before the server answers `initialize` */
async function testNothingLoadedBeforeInitialize(server) {
  const beforeAnswer = server.modules().filter((module) => module.at <= server.initializedAt && !module.url.startsWith('node:'));
  const loaded = heavyLoaded(beforeAnswer);
  assert.deepStrictEqual(loaded, [],
    `with no Excel, PDF or DOCX file opened, the server loaded ${loaded.join(', ')} before answering initialize ` +
    `(${beforeAnswer.length} modules resolved before the answer)`);
  console.log(`✓ Nothing for Excel, PDF or DOCX loaded before initialize was answered (${beforeAnswer.length} modules)`);
}

/** Nor once the tools are listed and the Chrome warm-up after the handshake has run */
async function testNothingLoadedAfterWarmUp(server) {
  await server.client.listTools();
  assert(await server.waitForChromeWarmUp(WARM_UP_TIMEOUT_MS),
    `the Chrome warm-up after the handshake did not finish within ${WARM_UP_TIMEOUT_MS} ms`);
  const loaded = heavyLoaded(server.modules());
  assert.deepStrictEqual(loaded, [],
    `with no Excel, PDF or DOCX file opened, the server loaded ${loaded.join(', ')} by the time tools/list ` +
    'was answered and the Chrome warm-up had run');
  console.log('✓ Nothing for Excel, PDF or DOCX loaded after tools/list and the Chrome warm-up');
}

/** Each package loads when a file first needs it, and the file works */
async function testLoadedOnFirstUse(server, dir) {
  const { client } = server;
  const xlsx = path.join(dir, 'budget.xlsx');
  await callTool(client, 'write_file', { path: xlsx, content: JSON.stringify([['Item', 'Note'], ['Alice', 'ZebraQuartz budget']]) });
  assert(/ZebraQuartz budget/.test(await callTool(client, 'read_file', { path: xlsx })),
    'reading back a spreadsheet written through the server should show its cells');

  const docx = path.join(dir, 'memo.docx');
  await callTool(client, 'write_file', { path: docx, content: 'Memo title\nThe ZebraQuartz review is due' });
  await callTool(client, 'edit_block', { file_path: docx, old_string: 'ZebraQuartz', new_string: 'ZebraQuokka' });
  assert(/ZebraQuokka review/.test(await callTool(client, 'read_file', { path: docx })),
    'reading back a DOCX written and edited through the server should show the edited text');

  assert((await callTool(client, 'read_file', { path: SAMPLE_PDF })).trim().length > 0,
    'reading a PDF through the server should return its text');

  const loaded = heavyLoaded(server.modules());
  for (const pkg of ['exceljs', 'pizzip', '@opendocsg/pdf2md']) {
    assert(loaded.includes(pkg), `${pkg} should be loaded once a file needed it; loaded: ${loaded.join(', ') || 'none'}`);
  }
  console.log('✓ Excel, DOCX and PDF files work on first use, loading their packages then');
}

export default async function runTests() {
  if (!isTestHome()) {
    skip('test-startup-imports.js writes to the home: run it through node test/run-all-tests.js');
    return true;
  }
  const dir = fs.mkdtempSync(path.join(os.homedir(), 'startup-imports-'));
  const failures = [];
  let server;
  try {
    server = await startServerRecordingModules();
    for (const test of [testNothingLoadedBeforeInitialize, testNothingLoadedAfterWarmUp, testLoadedOnFirstUse]) {
      try {
        await test(server, dir);
      } catch (error) {
        failures.push(error);
        console.error(`❌ ${test.name}: ${error.message}`);
      }
    }
  } finally {
    await server?.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  if (failures.length > 0) {
    console.error(`❌ ${failures.length} startup import test(s) failed`);
    return false;
  }
  console.log('✅ Startup import tests passed');
  return true;
}

runIfMain(import.meta.url, runTests);
