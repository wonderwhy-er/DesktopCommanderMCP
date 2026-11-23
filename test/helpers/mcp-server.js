import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { closeClient } from './close-client.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The stdio transport to the built server (dist/index.js), not yet started:
 * this Node runs it with `nodeArgs` (Node options such as --import) before it.
 * The server gets `env`, this process's environment unless a test passes
 * another (the SDK adds its own default set to it, as for any MCP client).
 */
export function serverTransport({ env = process.env, nodeArgs = [] } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...nodeArgs, path.join(PROJECT_ROOT, 'dist/index.js'), '--no-onboarding'],
    cwd: PROJECT_ROOT,
    stderr: 'pipe',
    env: { ...env },
  });
  // Read and drop the server's stderr: a full pipe never closes, and closing the client then ends the test early with code 0
  transport.stderr?.resume();
  return transport;
}

/**
 * Starts the built server (dist/index.js) the way `desktop-commander remote`
 * starts its local MCP: client "desktop-commander-client", DC_REMOTE_DEVICE=true.
 * Resolves once `initialize` has succeeded; rejects with the client's error
 * otherwise (e.g. `MCP error -32603: …`, which `remote` reports as
 * "Device startup failed").
 *
 * The result collects what the server reports: `logs` (its console output,
 * which reaches the client as log notifications: `{ level, data }`) and
 * `stderr`. Call `close()` when done.
 */
export async function startServerLikeRemote(env, { timeout = 30_000 } = {}) {
  const transport = serverTransport({ env: { ...env, DC_REMOTE_DEVICE: 'true' } });
  const client = new Client({ name: 'desktop-commander-client', version: '1.0.0' }, { capabilities: {} });
  const server = {
    client,
    logs: [],
    stderr: '',
    close: () => closeClient(client),
  };
  transport.stderr?.on('data', (chunk) => { server.stderr += chunk; });
  client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => { server.logs.push(notification.params); });
  try {
    await client.connect(transport, { timeout });
  } catch (error) {
    await server.close();
    throw error;
  }
  return server;
}
