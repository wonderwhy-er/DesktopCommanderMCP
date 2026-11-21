#!/usr/bin/env node
/**
 * Regression test for issue #1069:
 * Ensures every registered MCP tool inputSchema validates against
 * @modelcontextprotocol/sdk's ListToolsResultSchema (top-level type: "object")
 * and that schema conversion works for both Zod 3 and Zod 4 schemas without
 * silently dropping `type: "object"` (which previously caused `tools[24].inputSchema.type`
 * validation failures during Remote Device startup).
 */

import assert from 'node:assert/strict';
import { z as z3 } from 'zod';
import { z as z4 } from 'zod/v4';
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import * as schemasModule from '../dist/tools/schemas.js';
import { getSupportedParams, detectUnsupportedParams } from '../dist/utils/unsupportedParams.js';
import { connectToServer } from './helpers/mcp-client.js';
import { exitProcess } from '../dist/utils/exit-process.js';

const EMPTY_INPUT_TOOLS = new Set([
  'list_processes',
  'list_searches',
  'list_sessions',
  'get_usage_stats',
  'give_feedback_to_desktop_commander',
]);

const EXPECTED_REQUIRED = {
  set_config_value: ['key', 'value'],
  read_file: ['path'],
  read_multiple_files: ['paths'],
  write_file: ['path', 'content'],
  write_pdf: ['path', 'content'],
  create_directory: ['path'],
  list_directory: ['path'],
  move_file: ['source', 'destination'],
  start_search: ['path', 'pattern'],
  get_more_search_results: ['sessionId'],
  stop_search: ['sessionId'],
  get_file_info: ['path'],
  edit_block: ['file_path'],
  start_process: ['command', 'timeout_ms'],
  read_process_output: ['pid'],
  interact_with_process: ['pid', 'input'],
  force_terminate: ['pid'],
  kill_process: ['pid'],
};

async function runTests() {
  console.log('\n=== Test: Tool Input Schema Validation (#1069) ===\n');

  // 1. toToolInputSchema helper must exist and handle Zod 3 + Zod 4 schemas
  assert.equal(
    typeof schemasModule.toToolInputSchema,
    'function',
    'dist/tools/schemas.js must export toToolInputSchema',
  );
  const { toToolInputSchema, toolArgSchemas } = schemasModule;

  // 2. Every registered schema in toolArgSchemas must convert to a valid object JSON Schema
  const syntheticTools = Object.entries(toolArgSchemas).map(([name, schema]) => {
    const inputSchema = toToolInputSchema(schema);
    assert.equal(
      inputSchema?.type,
      'object',
      `${name} inputSchema must have top-level type: "object"`,
    );
    return { name, inputSchema };
  });

  const syntheticValidation = ListToolsResultSchema.safeParse({ tools: syntheticTools });
  assert.equal(
    syntheticValidation.success,
    true,
    `All toolArgSchemas must pass ListToolsResultSchema: ${
      syntheticValidation.success ? '' : JSON.stringify(syntheticValidation.error.issues)
    }`,
  );
  console.log(`   ✓ All ${syntheticTools.length} toolArgSchemas convert to valid object schemas`);

  // 3. Zod 4 schemas (including empty z.object({}), preprocess, refine, and 2-arg z.record)
  //    must also convert to valid object JSON Schemas and pass ListToolsResultSchema
  const z4Empty = z4.object({});
  const z4EmptyJson = toToolInputSchema(z4Empty);
  assert.equal(z4EmptyJson.type, 'object', 'Zod 4 empty z.object({}) must produce type: "object"');

  const z4Complex = z4.object({
    path: z4.string(),
    content: z4.preprocess(
      (val) => (typeof val === 'string' && val.trim().startsWith('[') ? JSON.parse(val) : val),
      z4.union([z4.string(), z4.array(z4.object({ type: z4.literal('delete') }))]),
    ),
    options: z4.record(z4.string(), z4.any()).optional(),
  }).refine((d) => Boolean(d.path), { message: 'path required' });
  const z4ComplexJson = toToolInputSchema(z4Complex);
  assert.equal(z4ComplexJson.type, 'object', 'Zod 4 refined/preprocessed object must produce type: "object"');
  assert.ok(Object.hasOwn(z4ComplexJson.properties ?? {}, 'path'), 'Zod 4 schema must preserve path property');
  assert.ok(Object.hasOwn(z4ComplexJson.properties ?? {}, 'content'), 'Zod 4 schema must preserve content property');
  assert.ok((z4ComplexJson.required ?? []).includes('path'), 'Zod 4 schema must preserve required path');

  const z4ToolsList = ListToolsResultSchema.safeParse({
    tools: [
      { name: 'z4_complex', inputSchema: z4ComplexJson },
      { name: 'z4_empty', inputSchema: z4EmptyJson },
    ],
  });
  assert.equal(
    z4ToolsList.success,
    true,
    `Zod 4 converted schemas must pass ListToolsResultSchema: ${
      z4ToolsList.success ? '' : JSON.stringify(z4ToolsList.error.issues)
    }`,
  );
  console.log('   ✓ Zod 4 schemas (empty, preprocess, refine, record) convert to valid object schemas');

  // 4. Non-object schemas must throw rather than silently emitting invalid MCP tool schemas
  assert.throws(
    () => toToolInputSchema(z3.string()),
    /object/i,
    'toToolInputSchema must reject non-object Zod 3 schemas',
  );
  assert.throws(
    () => toToolInputSchema(z4.string()),
    /object/i,
    'toToolInputSchema must reject non-object Zod 4 schemas',
  );
  console.log('   ✓ Non-object schemas are rejected cleanly');

  // 5. Unsupported parameter detection must work for both Zod 3 and Zod 4 schemas
  const z4RefinedObj = z4.object({ path: z4.string(), offset: z4.number().optional() }).refine(() => true);
  assert.deepEqual(getSupportedParams(z4RefinedObj), ['path', 'offset']);
  assert.deepEqual(detectUnsupportedParams({ path: 'a.txt', view_range: [1, 2] }, z4RefinedObj), ['view_range']);

  const z4PreprocessedObj = z4.preprocess((v) => v, z4.object({ path: z4.string() }));
  assert.deepEqual(getSupportedParams(z4PreprocessedObj), ['path']);
  assert.deepEqual(detectUnsupportedParams({ path: 'a.txt', view_range: [1, 2] }, z4PreprocessedObj), ['view_range']);

  const z4TransformedObj = z4.object({ path: z4.string() }).transform((v) => v);
  assert.deepEqual(getSupportedParams(z4TransformedObj), ['path']);
  console.log('   ✓ Unsupported-parameter detection works for Zod 4 schemas (refine, preprocess, transform)');

  // 6. Live MCP server tools/list must pass ListToolsResultSchema for every advertised tool
  const client = await connectToServer('schema-validation-test');
  try {
    const result = await client.listTools();
    const liveValidation = ListToolsResultSchema.safeParse(result);
    assert.equal(
      liveValidation.success,
      true,
      `Live tools/list must pass ListToolsResultSchema: ${
        liveValidation.success ? '' : JSON.stringify(liveValidation.error.issues)
      }`,
    );
    assert.ok(result.tools.length >= 25, `Expected at least 25 advertised tools, got ${result.tools.length}`);

    for (const [index, tool] of result.tools.entries()) {
      assert.equal(
        tool.inputSchema?.type,
        'object',
        `tools[${index}] (${tool.name}) inputSchema.type must be "object"`,
      );
      if (EMPTY_INPUT_TOOLS.has(tool.name)) {
        assert.deepEqual(
          tool.inputSchema.properties ?? {},
          {},
          `tools[${index}] (${tool.name}) should have empty properties`,
        );
      } else {
        assert.ok(
          Object.keys(tool.inputSchema.properties ?? {}).length > 0,
          `tools[${index}] (${tool.name}) must expose input properties`,
        );
      }

      const expectedReq = EXPECTED_REQUIRED[tool.name];
      if (expectedReq) {
        for (const prop of expectedReq) {
          assert.ok(
            Object.hasOwn(tool.inputSchema.properties ?? {}, prop),
            `${tool.name} inputSchema must declare property "${prop}"`,
          );
          assert.ok(
            (tool.inputSchema.required ?? []).includes(prop),
            `${tool.name} inputSchema must require "${prop}"`,
          );
        }
      }
    }
    console.log(`   ✓ Live MCP tools/list returned ${result.tools.length} valid tool schemas (including tools[24]: ${result.tools[24]?.name})`);
  } finally {
    await client.close();
  }

  console.log('\n=== All Tool Input Schema Validation Tests Passed! ===\n');
}

runTests().catch((error) => {
  console.error('Test failed:', error);
  exitProcess(1);
});
