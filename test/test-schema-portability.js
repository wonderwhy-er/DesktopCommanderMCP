import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function collectSchemaIssues(schema, location, issues) {
  if (schema === null || typeof schema !== 'object') return;
  if (Array.isArray(schema)) {
    schema.forEach((item, index) =>
      collectSchemaIssues(item, `${location}[${index}]`, issues));
    return;
  }

  if (Object.keys(schema).length === 0) {
    issues.push(`${location}: empty schema`);
    return;
  }

  if ('$ref' in schema) {
    issues.push(`${location}: contains $ref`);
  }

  if (schema.type === 'object' && schema.additionalProperties !== false) {
    issues.push(`${location}: object schema must set additionalProperties to false`);
  }
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [propertyName, propertySchema] of Object.entries(value)) {
        if (
          propertySchema &&
          typeof propertySchema === 'object' &&
          !Array.isArray(propertySchema) &&
          Object.keys(propertySchema).length === 0
        ) {
          issues.push(`${location}.properties.${propertyName}: empty schema`);
        }
        collectSchemaIssues(propertySchema, `${location}.properties.${propertyName}`, issues);
      }
      continue;
    }
    if (key !== 'additionalProperties') {
      collectSchemaIssues(value, `${location}.${key}`, issues);
    }
  }
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, 'dist', 'index.js')],
  cwd: root,
  env: process.env,
  stderr: 'ignore',
});
const client = new Client({ name: 'schema-portability-test', version: '1' });

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const issues = [];

  for (const tool of tools) {
    collectSchemaIssues(tool.inputSchema, tool.name, issues);
  }

  assert.deepEqual(
    issues,
    [],
    `Published MCP tool schemas must remain portable:\n${issues.join('\n')}`,
  );
  console.log(`✓ ${tools.length} published MCP tool schemas are portable`);
} finally {
  await client.close();
}
