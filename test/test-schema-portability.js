import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { EditBlockArgsSchema, WritePdfArgsSchema } from '../dist/tools/schemas.js';

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
  assert.equal(tools.length, 26, 'Expected 26 published MCP tools');
  const issues = [];

  for (const tool of tools) {
    collectSchemaIssues(tool.inputSchema, tool.name, issues);
  }

  assert.deepEqual(
    issues,
    [],
    `Published MCP tool schemas must remain portable:\n${issues.join('\n')}`,
  );

  assert.equal(
    WritePdfArgsSchema.safeParse({
      path: 'out.pdf',
      content: '# PDF',
      options: { pdf_options: { margin: '20mm' } },
    }).success,
    true,
    'write_pdf must preserve md-to-pdf CSS-style margin strings',
  );
  assert.equal(
    EditBlockArgsSchema.safeParse({
      file_path: 'document.pdf',
      range: 'pages',
      content: [{ type: 'delete', pageIndexes: [0] }],
    }).success,
    true,
    'edit_block must preserve PDF operation arrays',
  );
  assert.equal(
    WritePdfArgsSchema.safeParse({
      path: 'out.pdf',
      content: '# PDF',
      options: { launch_options: { args: ['--no-sandbox'], headless: true } },
    }).success,
    true,
    'write_pdf must preserve supported Puppeteer launch options',
  );
  assert.equal(
    EditBlockArgsSchema.safeParse({
      file_path: 'sheet.xlsx',
      range: 'Sheet1!A1:A1',
      content: [[{ formula: 'A2+A3', result: 3 }]],
    }).success,
    true,
    'edit_block must preserve Excel formula cell values',
  );

  console.log(`✓ ${tools.length} published MCP tool schemas are portable`);
} finally {
  await client.close();
}
