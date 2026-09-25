/**
 * An unhandled promise rejection must not take the MCP server down: it is
 * logged and the server keeps serving (running processes, sessions and
 * searches survive). Drives the real server over stdio (dist/index.js) with a
 * preloaded fixture that rejects a promise nobody handles.
 */
import assert from 'assert';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { runIfMain } from './helpers/run-if-main.js';
import { closeClient } from './helpers/close-client.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRELOAD = pathToFileURL(path.join(PROJECT_ROOT, 'test/fixtures/unhandled-rejection-preload.mjs')).href;
// Counted from when the server's handler is in place (see the fixture). Shorter
// than the server takes to start, so a fixture that counted from the start of
// the process would reject before the handler exists, and this test would fail.
const REJECT_AFTER_MS = 100;
// The old handler exited within ~1 s of the rejection (exitProcess fallback)
const SURVIVAL_WINDOW_MS = 3000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) return false;
    await sleep(50);
  }
  return true;
}

async function run() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', PRELOAD, path.join(PROJECT_ROOT, 'dist/index.js'), '--no-onboarding'],
    cwd: PROJECT_ROOT,
    stderr: 'pipe',
    env: { ...process.env, DC_TEST_REJECT_AFTER_MS: String(REJECT_AFTER_MS) },
  });
  let serverOutput = '';
  transport.stderr?.on('data', (chunk) => { serverOutput += chunk; });
  let closed = false;
  const client = new Client({ name: 'unhandled-rejection-test', version: '1.0.0' }, { capabilities: {} });
  client.onclose = () => { closed = true; };
  client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
    serverOutput += `${notification.params.data}\n`;
  });

  try {
    await client.connect(transport, { timeout: 30_000 });

    assert(await waitFor(() => serverOutput.includes('fixture: rejecting now'), 15_000),
      `the fixture never rejected; server output:\n${serverOutput}`);
    assert(await waitFor(() => serverOutput.includes('Unhandled rejection: dc-test-rejection'), 5_000),
      `the server should log the rejection; server output:\n${serverOutput}`);
    console.log('✓ Rejection logged by the server');

    await sleep(SURVIVAL_WINDOW_MS);
    assert(!closed, `the server exited after an unhandled rejection; server output:\n${serverOutput}`);
    const result = await client.callTool({ name: 'get_config', arguments: {} });
    assert.notStrictEqual(result.isError, true, `get_config failed: ${result.content?.[0]?.text}`);
    console.log(`✓ Server still answers ${SURVIVAL_WINDOW_MS}ms after the rejection`);
  } finally {
    await closeClient(client);
  }
}

runIfMain(import.meta.url, run);

export default run;
