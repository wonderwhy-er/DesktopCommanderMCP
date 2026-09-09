#!/usr/bin/env node
/**
 * Regression test: the published start_search contract must describe the
 * different pattern semantics for file, text-content, and Office searches.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(PROJECT_ROOT, 'dist/index.js'), '--no-onboarding'],
  cwd: PROJECT_ROOT,
  stderr: 'pipe',
  env: { ...process.env, DESKTOP_COMMANDER_DISABLE_TELEMETRY: 'true' },
});

const client = new Client(
  { name: 'search-contract-test', version: '1.0.0' },
  { capabilities: {} }
);

try {
  await client.connect(transport, { timeout: 30000 });
  const tools = await client.listTools();
  const searchTool = tools.tools.find((tool) => tool.name === 'start_search');
  assert.ok(searchTool, 'start_search should be published');

  const description = searchTool.description ?? '';
  assert.match(description, /file(?:-name)? searches?.*glob/is,
    'tool description should explain that file-name search uses glob semantics');
  assert.match(description, /file(?:-name)? searches?.*(?:not|instead of).*regular expressions?/is,
    'tool description should explicitly distinguish file-name search from regex');
  assert.match(description, /literalSearch.*only.*text content/is,
    'tool description should scope literalSearch to text content search');
  assert.match(description, /Excel.*DOCX.*literal/is,
    'tool description should document Office content as literal matching');

  const properties = searchTool.inputSchema?.properties ?? {};
  assert.match(properties.pattern?.description ?? '', /files?.*glob.*content.*regex/is,
    'pattern schema should distinguish file glob and content regex semantics');
  assert.match(properties.literalSearch?.description ?? '', /text content.*files?.*ignored/is,
    'literalSearch schema should say it applies to text content and is ignored for files');
  assert.match(properties.filePattern?.description ?? '', /glob/is,
    'filePattern schema should identify its syntax as glob');

  console.log('✅ start_search published contract documents matching semantics');
} finally {
  await client.close();
}
