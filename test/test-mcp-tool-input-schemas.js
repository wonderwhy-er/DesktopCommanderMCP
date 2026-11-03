#!/usr/bin/env node
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  toolMcpInputSchemas,
  toMcpInputSchema,
  WritePdfArgsSchema,
  EditBlockArgsSchema,
  KillProcessArgsSchema,
} from '../dist/tools/schemas.js';
import { connectToServer } from './helpers/mcp-client.js';

const EXPECTED_REQUIRED = {
  read_file: ['path'],
  write_file: ['path', 'content'],
  write_pdf: ['path', 'content'],
  list_directory: ['path'],
  get_file_info: ['path'],
  start_process: ['command', 'timeout_ms'],
  set_config_value: ['key', 'value'],
  edit_block: ['file_path'],
  kill_process: ['pid'],
};

const EMPTY_INPUT_TOOLS = new Set([
  'list_processes',
  'list_searches',
  'list_sessions',
  'get_usage_stats',
  'give_feedback_to_desktop_commander',
]);

for (const [name, schema] of Object.entries(toolMcpInputSchemas)) {
  const jsonSchema = z.toJSONSchema(schema, { target: 'draft-07', io: 'input' });
  assert.deepEqual(toMcpInputSchema(schema), jsonSchema, `${name} uses native input conversion`);
  assert.equal(jsonSchema.type, 'object', `${name} must convert to an object schema`);
}

assert.equal(
  WritePdfArgsSchema.safeParse({ path: 'output.pdf', content: '[{"type":"delete","pageIndexes":[0]}]' }).success,
  true,
  'write_pdf keeps parsing JSON-array strings at runtime',
);
assert.equal(
  EditBlockArgsSchema.safeParse({ file_path: 'notes.txt' }).success,
  false,
  'edit_block keeps enforcing its cross-field argument requirement',
);
assert.equal(
  KillProcessArgsSchema.safeParse({ pid: -1 }).success,
  false,
  'kill_process keeps rejecting non-positive PIDs at runtime',
);

const client = await connectToServer('schema-contract-test');
try {
  const { tools } = await client.listTools();
  assert.ok(tools.length >= 20, `expected the normal tool set; got ${tools.length}`);

  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  for (const tool of tools) {
    assert.equal(tool.inputSchema?.type, 'object', `${tool.name} must publish an object input schema`);
    if (EMPTY_INPUT_TOOLS.has(tool.name)) {
      assert.deepEqual(tool.inputSchema.properties ?? {}, {}, `${tool.name} should have no input properties`);
    } else {
      assert.ok(
        Object.keys(tool.inputSchema.properties ?? {}).length > 0,
        `${tool.name} must publish its argument properties`,
      );
    }
  }

  for (const [name, required] of Object.entries(EXPECTED_REQUIRED)) {
    const tool = byName.get(name);
    assert.ok(tool, `tools/list must include ${name}`);
    for (const property of required) {
      assert.ok(
        Object.hasOwn(tool.inputSchema.properties ?? {}, property),
        `${name} inputSchema must declare ${property}`,
      );
      assert.ok(
        tool.inputSchema.required?.includes(property),
        `${name} inputSchema must require ${property}`,
      );
    }
  }
} finally {
  await client.close();
}

console.log('✓ all Zod tool schemas convert and tools/list publishes their inputs');
