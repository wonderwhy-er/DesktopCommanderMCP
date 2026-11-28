import assert from 'node:assert/strict';
import { startServerLikeRemote } from './helpers/mcp-server.js';
import { createTestEnv } from './helpers/test-env.js';

const { env, cleanup } = createTestEnv();
let server;
let schemas;
try {
  server = await startServerLikeRemote({
    ...env,
    DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1',
    DC_FLAG_URL: 'http://127.0.0.1:9/',
  });
  const { tools } = await server.client.listTools();
  assert.ok(tools.length > 0, 'tools/list returned no tools');
  schemas = Object.fromEntries(tools.map(({ name, inputSchema }) => [name, inputSchema]));
  assert.equal(Object.keys(schemas).length, tools.length, 'tools/list returned duplicate tool names');
} finally {
  try {
    await server?.client.close();
  } finally {
    cleanup();
  }
}

process.stdout.write(JSON.stringify(schemas, null, 2) + '\n');
