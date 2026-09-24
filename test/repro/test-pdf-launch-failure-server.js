// Server-level repro: one failed Chrome launch in write_pdf must not take the
// MCP server down.
//
// Drives the real server over stdio (dist/index.js, like an MCP client) and
// makes write_pdf's Chrome launch fail with options.launch_options.timeout = 1,
// the same failure as a Chrome that never opens its DevTools endpoint. The
// tool call returns its error; Puppeteer used to delete Chrome's profile
// about 5 seconds later, in a promise nobody awaited, while Chrome still held
// it: EBUSY, an unhandled rejection, and src/index.ts exited the server
// (about 16 seconds after the call on Windows).
//
// Waits until Chrome's profile folder is gone (or the server exits, or 30 s
// pass), then checks the server still answers a tool call.
//
// Run: node test/repro/run-repro.js test-pdf-launch-failure-server.js
// Exit code: 1 if the server died or the profile folder was left behind.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { closeClient } from '../helpers/close-client.js';
import { exitProcess } from '../../dist/utils/exit-process.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WAIT_LIMIT_MS = 30_000;
/** Chrome profile folders: Desktop Commander's own, or one Puppeteer creates itself */
const PROFILE_PREFIXES = ['desktop-commander-chrome-profile-', 'puppeteer_dev_chrome_profile-'];

const T0 = Date.now();
const log = (m) => console.log(`[${Date.now() - T0}ms] ${m}`);

// The server (and the Chrome it starts) keep their temporary files here
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-repro-pdf-launch-failure-'));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(PROJECT_ROOT, 'dist/index.js'), '--no-onboarding'],
  cwd: PROJECT_ROOT,
  stderr: 'pipe',
  env: { ...process.env, TEMP: tempDir, TMP: tempDir, TMPDIR: tempDir },
});
let serverStderr = '';
transport.stderr?.on('data', (chunk) => { serverStderr += chunk; });
let serverClosedAt = null;
const client = new Client({ name: 'pdf-launch-failure-repro', version: '1.0.0' }, { capabilities: {} });
client.onclose = () => { serverClosedAt ??= Date.now(); };
// The server logs over MCP once the client is connected (src/index.ts's error handlers too)
const serverLogs = [];
client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
  serverLogs.push(`${notification.params.level}: ${notification.params.data}`);
});
await client.connect(transport, { timeout: 30_000 });
log('server connected');

// Chrome profile folders created in the server's temp folder (watched, not
// polled: after a failed launch the folder can come and go within milliseconds)
const profiles = new Set();
const watcher = fs.watch(tempDir, (event, name) => {
  if (name && PROFILE_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    profiles.add(name);
  }
});
const remainingProfiles = () => [...profiles].filter((name) => fs.existsSync(path.join(tempDir, name)));

let failed = false;
try {
  const result = await client.callTool({
    name: 'write_pdf',
    arguments: {
      path: path.join(tempDir, 'never-written.pdf'),
      content: '# Never rendered',
      options: { launch_options: { timeout: 1 } },
    },
  }, undefined, { timeout: 60_000 });
  const text = result.content?.find((block) => block.type === 'text')?.text ?? '';
  log(`write_pdf returned isError=${Boolean(result.isError)}: ${text.split('\n')[0]}`);
  if (!result.isError) {
    log('✗ write_pdf should have failed');
    failed = true;
  }

  const waitStart = Date.now();
  while ((profiles.size === 0 || remainingProfiles().length > 0) && serverClosedAt === null && Date.now() - waitStart < WAIT_LIMIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  watcher.close();

  if (serverClosedAt !== null) {
    log(`✗ SERVER DIED ${serverClosedAt - waitStart}ms after write_pdf returned.`);
    log(`  last server log: ${serverLogs.at(-1) ?? 'none'}`);
    log(`  server stderr: ${serverStderr.trim() || 'none'}`);
    failed = true;
  } else {
    const config = await client.callTool({ name: 'get_config', arguments: {} }, undefined, { timeout: 30_000 });
    log(`server still answers: get_config isError=${Boolean(config.isError)}`);
    if (config.isError) failed = true;
  }

  const left = remainingProfiles();
  log(`Chrome profile folders seen: ${[...profiles].join(', ') || 'none'}; left behind: ${left.join(', ') || 'none'}`);
  if (profiles.size === 0 || left.length > 0) failed = true;
} finally {
  watcher.close();
  await closeClient(client);
  try {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5 });
  } catch (error) {
    log(`could not remove ${tempDir}: ${error.message}`);
  }
}

log(failed ? 'REPRODUCED: a failed Chrome launch broke the server' : 'OK: the failed launch was an ordinary tool error');
exitProcess(failed ? 1 : 0);
