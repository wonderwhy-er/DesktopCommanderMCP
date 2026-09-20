#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(testDir, '../dist/index.js');

async function listToolsWithProjection(enabled) {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-semantic-tools-'));
  const configDir = path.join(tempHome, '.claude-server-commander');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(
    path.join(configDir, 'config.json'),
    JSON.stringify({
      semanticProjectionEnabled: enabled,
      semanticProjectionModel: 'jev-latest',
      telemetryEnabled: false,
      allowedDirectories: [],
    }),
  );

  const client = new Client(
    { name: 'semantic-tool-advertisement-test', version: '1.0.0' },
    { capabilities: {} },
  );
  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverPath],
    env: {
      ...process.env,
      HOME: tempHome,
      TYPESAFE_API_KEY: 'test-typesafe-key-not-real',
    },
  });

  try {
    await client.connect(transport);
    return (await client.listTools()).tools;
  } finally {
    await client.close().catch(() => {});
    await fs.rm(tempHome, { recursive: true, force: true });
  }
}

function getTool(tools, name) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `Expected tool ${name}`);
  return tool;
}

const disabledTools = await listToolsWithProjection(false);
for (const name of ['read_file', 'read_multiple_files', 'read_process_output']) {
  const tool = getTool(disabledTools, name);
  assert.equal(tool.inputSchema?.properties?.projection, undefined, `${name} must not advertise projection when disabled`);
  assert.doesNotMatch(tool.description ?? '', /semantic projection/i);
}
assert.doesNotMatch(
  getTool(disabledTools, 'set_config_value').description ?? '',
  /semanticProjectionApiKey/,
);

const enabledTools = await listToolsWithProjection(true);
for (const name of ['read_file', 'read_multiple_files', 'read_process_output']) {
  const tool = getTool(enabledTools, name);
  const projection = tool.inputSchema?.properties?.projection;
  assert.ok(projection, `${name} should advertise projection when enabled`);
  const projectionSchema = projection.properties ? projection : projection;
  const serialized = JSON.stringify(projectionSchema);
  assert.match(serialized, /minRelevance/);
  assert.doesNotMatch(serialized, /"limit"/);
  assert.match(tool.description ?? '', /quality gate/i);
}
assert.match(
  getTool(enabledTools, 'set_config_value').description ?? '',
  /semanticProjectionApiKey/,
);

console.log('✅ Semantic projection tool advertisement tests passed');
