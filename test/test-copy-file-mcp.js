/**
 * Regression for #676: copy_file must be exposed as an MCP tool,
 * not just as a callable internal filesystem handler.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { connectToServer, closeClient } from './helpers/mcp-client.js';
import { createTempDir } from './helpers/test-env.js';
import { runIfMain } from './helpers/run-if-main.js';

export default async function runTests() {
  const dir = createTempDir('dc-copy-file-mcp-');
  let client;
  try {
    client = await connectToServer('copy-file-regression');
    const catalog = await client.listTools();
    const entry = catalog.tools.find((tool) => tool.name === 'copy_file');
    assert.ok(entry, 'MCP tools/list must advertise copy_file');
    assert.ok(entry.inputSchema.properties.source);
    assert.ok(entry.inputSchema.properties.destination);
    const manifest = JSON.parse(await fs.readFile(new URL('../manifest.template.json', import.meta.url), 'utf8'));
    assert.ok(manifest.tools.some((tool) => tool.name === 'copy_file'),
      'MCPB manifest template must include copy_file');

    const source = path.join(dir, 'original.txt');
    const destination = path.join(dir, 'copy.txt');
    await fs.writeFile(source, 'original');
    const response = await client.callTool({
      name: 'copy_file', arguments: { source, destination },
    });
    assert.notEqual(response.isError, true, JSON.stringify(response.content));
    assert.equal(await fs.readFile(source, 'utf8'), 'original');
    assert.equal(await fs.readFile(destination, 'utf8'), 'original');
    console.log('ok - copy_file appears in tools/list and tools/call copies without moving');
    return true;
  } finally {
    if (client) await closeClient(client);
    await fs.rm(dir, { recursive: true, force: true });
  }
}

runIfMain(import.meta.url, runTests);
