/**
 * The user's path to Desktop Commander: the built server (dist/index.js) in
 * its own process, talked to over stdio with the SDK client, as an MCP client
 * does. Closing the client ends the server.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
export { closeClient } from './close-client.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Starts the server and returns a connected client; the caller closes it */
export async function connectToServer(clientName) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(PROJECT_ROOT, 'dist/index.js'), '--no-onboarding'],
    cwd: PROJECT_ROOT,
    stderr: 'pipe',
    env: { ...process.env },
  });
  const client = new Client({ name: clientName, version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport, { timeout: 30_000 });
  return client;
}

/**
 * What a start_search or get_more_search_results answer says, read from its
 * text as a client reads it (the tools' structuredContent stays in the server):
 * the session, whether the search is complete, and get_more_search_results'
 * counts.
 */
export function readSearchAnswer(result) {
  const text = result.content?.[0]?.text ?? '';
  const counts = /^Total results found: (\d+) \((\d+) matches\)$/m.exec(text);
  return {
    text,
    sessionId: /session: (\S+)/.exec(text)?.[1],
    isComplete: /^Status: COMPLETED$/m.test(text),
    totalResults: counts ? Number(counts[1]) : undefined,
    totalMatches: counts ? Number(counts[2]) : undefined,
  };
}
