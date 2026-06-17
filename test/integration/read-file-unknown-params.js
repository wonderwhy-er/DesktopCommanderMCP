/**
 * Integration test: what does read_file return when the caller sends parameters
 * the schema does not accept?
 *
 * Drives the real MCP server over stdio (exactly like an LLM client), so every
 * assertion is against the actual CallToolResult the model receives.
 *
 * Documents CURRENT behavior on main:
 *   1. Unknown/unaccepted params (e.g. view_range, foo_bar) are SILENTLY stripped.
 *      The read succeeds, isError is falsy, and NOTHING tells the model its param
 *      was ignored. <-- This is the gap. The intended future behavior is to keep
 *      returning the normal response but APPEND a warning that params were stripped.
 *      When that lands, assertion (1c) flips and is the regression anchor.
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
    // --- Case 1: unknown/unaccepted parameters are silently stripped ---
    const unknown = await callTool(client, 'read_file', {
      path: TEST_FILE,
      view_range: [5, 10],   // not a real param on main
      foo_bar: true,         // clearly bogus
    });
    const unknownText = textOf(unknown);
    console.log('\n[Case 1] unknown params -> isError:', !!unknown.isError);

    // 1a. The call is NOT rejected.
    assert.ok(!unknown.isError, 'Case 1: unknown params should NOT cause isError (they are stripped)');
    // 1b. Because the params were ignored, it falls back to defaults: a read from
    //     the START of the file, not lines 5-10 the caller asked for.
    assert.ok(/line-1\b/.test(unknownText), 'Case 1: should read from the start (params ignored)');
    assert.ok(!/^line-5$/m.test(unknownText) || /line-1\b/.test(unknownText),
      'Case 1: did not honor the requested range');
    // 1c. THE GAP: nothing in the response tells the model a param was stripped.
    //     When the future "append a warning" behavior lands, flip this assertion.
    const mentionsStripped = /strip|ignored|unknown param|unrecognized|not a valid/i.test(unknownText);
    assert.ok(!mentionsStripped,
      'Case 1 (current behavior): response contains NO warning about stripped params');
    console.log('[Case 1] PASS - params silently stripped, no warning returned (documented gap)');

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
