/**
 * Integration test: what does read_file return when the caller sends parameters
 * the schema does not accept?
 *
 * Drives the real MCP server over stdio (exactly like an LLM client), so every
 * assertion is against the actual CallToolResult the model receives.
 *
 * Documents and validates behavior:
 *   1. Unsupported params (e.g. view_range, foo_bar) are stripped, the read still
 *      succeeds (isError falsy), and a corrective warning is PREPENDED as the
 *      first content block, naming the ignored params and listing the supported
 *      ones. This is the unsupported-parameter warning feature.
 *   2. Wrong type on a known param -> dispatcher-shaped isError: true.
 *   3. Missing required param (path) -> dispatcher-shaped isError: true.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'assert';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const TEST_DIR = path.join(__dirname, 'test_read_file_unknown_params');
const TEST_FILE = path.join(TEST_DIR, 'numbered.txt');
const LINE_COUNT = 50;

async function callTool(client, name, args) {
  return client.callTool({ name, arguments: args }, undefined, { timeout: 30000 });
}

function textOf(result) {
  return result?.content?.find?.((c) => c.type === 'text')?.text ?? '';
}

async function createMcpClient() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(PROJECT_ROOT, 'dist/index.js'), '--no-onboarding'],
    cwd: PROJECT_ROOT,
    stderr: 'pipe',
    env: { ...process.env, DESKTOP_COMMANDER_DISABLE_TELEMETRY: 'true' },
  });

  const client = new Client(
    { name: 'desktop-commander-unknown-params-test', version: '1.0.0' },
    { capabilities: {} }
  );
  await client.connect(transport, { timeout: 30000 });
  return client;
}

async function setup(client) {
  await fs.rm(TEST_DIR, { recursive: true, force: true });
  await fs.mkdir(TEST_DIR, { recursive: true });
  const lines = Array.from({ length: LINE_COUNT }, (_, i) => `line-${i + 1}`);
  await fs.writeFile(TEST_FILE, lines.join('\n'));

  const original = await callTool(client, 'get_config', {});
  const entries = original.structuredContent?.entries;
  assert.ok(Array.isArray(entries), 'get_config should return structured entries');
  const originalConfig = Object.fromEntries(
    entries.filter((e) => e && e.editable === true).map((e) => [e.key, e.value])
  );

  const set = await callTool(client, 'set_config_value', {
    key: 'allowedDirectories', value: [TEST_DIR], origin: 'llm',
  });
  assert.ok(!set.isError, 'set_config_value allowedDirectories should succeed');
  return originalConfig;
}

async function teardown(client, originalConfig) {
  for (const [key, value] of Object.entries(originalConfig)) {
    await callTool(client, 'set_config_value', { key, value, origin: 'llm' });
  }
  await fs.rm(TEST_DIR, { recursive: true, force: true });
}

async function main() {
  console.log('===== read_file Unknown-Parameter Behavior Integration Test =====');
  const client = await createMcpClient();
  const originalConfig = await setup(client);

  try {
    // --- Case 0: a clean call gets NO warning (guards against over-firing) ---
    const clean = await callTool(client, 'read_file', { path: TEST_FILE, offset: 0, length: 3 });
    const cleanFirst = (clean.content || []).find((c) => c.type === 'text')?.text || '';
    assert.ok(!clean.isError, 'Case 0: valid call should succeed');
    assert.ok(!/not supported|ignored/i.test(cleanFirst),
      'Case 0: valid call should NOT get an unsupported-params warning');
    assert.ok(/line-1\b/.test(cleanFirst), 'Case 0: valid call returns file content first');
    console.log('[Case 0] PASS - clean call has no warning');

    // --- Case 1: unsupported parameters are stripped, with a corrective warning ---
    const unknown = await callTool(client, 'read_file', {
      path: TEST_FILE,
      view_range: [5, 10],   // not a supported param
      foo_bar: true,         // clearly bogus
    });
    const blocks = (unknown.content || []).filter((c) => c.type === 'text').map((c) => c.text);
    const firstBlock = blocks[0] || '';
    const joined = blocks.join('\n');
    console.log('\n[Case 1] unsupported params -> isError:', !!unknown.isError);

    // 1a. The call is NOT rejected; unsupported params don't fail the read.
    assert.ok(!unknown.isError, 'Case 1: unsupported params should NOT cause isError');
    // 1b. A corrective warning is PREPENDED as the first content block.
    assert.ok(/not supported|ignored/i.test(firstBlock),
      'Case 1: first content block should be the unsupported-params warning');
    // 1c. The warning names exactly the params that were ignored.
    assert.ok(/view_range/.test(firstBlock) && /foo_bar/.test(firstBlock),
      'Case 1: warning should name the ignored params (view_range, foo_bar)');
    // 1d. The warning lists the supported params (the corrective part).
    assert.ok(/path/.test(firstBlock) && /offset/.test(firstBlock) && /length/.test(firstBlock),
      'Case 1: warning should list the supported params');
    // 1e. The read still happened (from the start, since the params were ignored).
    assert.ok(/line-1\b/.test(joined), 'Case 1: file content still returned (read from start)');
    console.log('[Case 1] PASS - ignored params named + supported list returned, read still served');

    // --- Case 2: wrong type on a known param -> shaped isError ---
    const badType = await callTool(client, 'read_file', { path: TEST_FILE, offset: 'not-a-number' });
    console.log('[Case 2] wrong type -> isError:', !!badType.isError);
    assert.ok(badType.isError, 'Case 2: wrong type should return isError: true');
    assert.ok(/offset/i.test(textOf(badType)), 'Case 2: error should reference offset');
    console.log('[Case 2] PASS - wrong type surfaced to the model');

    // --- Case 3: missing required param -> shaped isError ---
    const missing = await callTool(client, 'read_file', { offset: 2 });
    console.log('[Case 3] missing path -> isError:', !!missing.isError);
    assert.ok(missing.isError, 'Case 3: missing path should return isError: true');
    console.log('[Case 3] PASS - missing required param surfaced to the model');

    console.log('\nAll assertions passed. Current read_file param behavior is documented.');
  } finally {
    await teardown(client, originalConfig);
    await client.close();
  }
}

main().catch((err) => {
  console.error('\nTEST FAILED:', err && err.message ? err.message : err);
  process.exit(1);
});
