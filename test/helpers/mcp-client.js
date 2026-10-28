/**
 * The user's path to Desktop Commander: the built server (dist/index.js) in
 * its own process, talked to over stdio with the SDK client, as an MCP client
 * does. Closing the client ends the server.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { serverTransport } from './mcp-server.js';
export { closeClient } from './close-client.js';

/**
 * Starts the server (serverTransport()) and returns a connected client; the
 * caller closes it. The server gets `env`, this process's environment unless a
 * test passes another.
 */
export async function connectToServer(clientName, env) {
  const client = new Client({ name: clientName, version: '1.0.0' }, { capabilities: {} });
  await client.connect(serverTransport({ env }), { timeout: 30_000 });
  return client;
}

/**
 * What a start_search or get_more_search_results answer says, read from its
 * text as a client reads it (the tools' structuredContent stays in the server):
 * the session, whether the search is complete, and its counts ("Total results:
 * 2 matches (9 rows with context)": matches, and rows when context adds some).
 */
export function readSearchAnswer(result) {
  const text = result.content?.[0]?.text ?? '';
  const counts = /^Total results: (\d+) match(?:es)?(?: \((\d+) rows with context\))?$/m.exec(text);
  return {
    text,
    sessionId: /session: (\S+)/.exec(text)?.[1],
    isComplete: /^Status: COMPLETED$/m.test(text),
    totalResults: counts ? Number(counts[2] ?? counts[1]) : undefined,
    totalMatches: counts ? Number(counts[1]) : undefined,
  };
}
