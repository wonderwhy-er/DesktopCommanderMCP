import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  EditBlockArgsSchema,
  GetRecentToolCallsArgsSchema,
  KillProcessArgsSchema,
  ReadFileArgsSchema,
  StartSearchArgsSchema,
  TrackUiEventArgsSchema,
  WritePdfArgsSchema,
} from '../dist/tools/schemas.js';
import { startServerLikeRemote } from './helpers/mcp-server.js';
import { answerText } from './helpers/mcp-client.js';
import { runIfMain } from './helpers/run-if-main.js';
import { createTestEnv } from './helpers/test-env.js';

function checkValidation() {
  assert.deepEqual(ReadFileArgsSchema.parse({ path: 'notes.txt', options: { nested: { test: 1 } } }), {
    path: 'notes.txt', isUrl: false, offset: 0, length: 1000, options: { nested: { test: 1 } },
  });
  const search = { path: '.', pattern: 'test' };
  assert.equal(StartSearchArgsSchema.parse(search).searchType, 'files');
  assert.equal(StartSearchArgsSchema.parse({ ...search, maxResults: 1e20 }).maxResults, 1e20);
  for (const maxResults of [-1, 1.5]) {
    assert.equal(StartSearchArgsSchema.safeParse({ ...search, maxResults }).success, false);
  }

  const edits = [{ type: 'delete', pageIndexes: [0] }];
  const pdf = { path: 'test.pdf', options: { custom: true } };
  for (const content of [edits, JSON.stringify(edits)]) {
    assert.deepEqual(WritePdfArgsSchema.parse({ ...pdf, content }), { ...pdf, content: edits });
  }
  assert.equal(WritePdfArgsSchema.parse({ ...pdf, content: '[Markdown' }).content, '[Markdown');
  assert.equal(WritePdfArgsSchema.safeParse({ ...pdf, content: '[{"type":"delete"}]' }).success, false);

  const file_path = 'notes.txt';
  assert.equal(EditBlockArgsSchema.parse({ file_path, old_string: 'a', new_string: '' }).expected_replacements, 1);
  assert.deepEqual(EditBlockArgsSchema.parse({ file_path, range: 'A1', content: [[1]] }).content, [[1]]);
  for (const args of [{}, { old_string: 'a' }, { range: 'A1' }, { range: 'A1', content: '' }]) {
    assert.equal(EditBlockArgsSchema.safeParse({ file_path, ...args }).success, false);
  }
  assert.equal(KillProcessArgsSchema.parse({ pid: 1 }).pid, 1);
  for (const pid of [0, -1]) {
    assert.match(KillProcessArgsSchema.safeParse({ pid }).error.issues[0].message, /greater than 0/);
  }

  for (const since of ['2024-02-29T12:01Z', '2024-02-29T12:01:02.123Z']) {
    assert.deepEqual(GetRecentToolCallsArgsSchema.parse({ since }), { since, maxResults: 50 });
  }
  assert.equal(GetRecentToolCallsArgsSchema.safeParse({ since: '2023-02-29T12:01Z' }).success, false);

  assert.deepEqual(TrackUiEventArgsSchema.parse({ event: 'fixture' }), {
    event: 'fixture', component: 'file_preview', params: {},
  });
  const params = { text: 'value', count: 2, enabled: true, empty: null };
  assert.deepEqual(TrackUiEventArgsSchema.parse({ event: 'fixture', params }).params, params);
  assert.equal(TrackUiEventArgsSchema.safeParse({ event: 'fixture', params: { nested: {} } }).success, false);
}

async function run() {
  checkValidation();
  // Captured from tools/list on the Zod 3 server at c747342f. Keep the whole
  // contract so changes to defaults, nested PDF operations and records are visible.
  const expected = JSON.parse(await readFile(new URL('./fixtures/mcp-tool-input-schemas.json', import.meta.url), 'utf8'));
  const { env, home, cleanup } = createTestEnv();
  let server;
  try {
    server = await startServerLikeRemote(env);
    const { tools } = await server.client.listTools();
    assert.equal(tools.length, 25);
    assert.deepEqual(Object.fromEntries(tools.map(({ name, inputSchema }) => [name, inputSchema])), expected);

    const file = path.join(home, 'notes.txt');
    await writeFile(file, 'original');
    const result = await server.client.callTool({
      name: 'edit_block',
      arguments: { file_path: file, old_string: 'original', new_string: 'edited', extra_arg: true },
    });
    assert.ok(!result.isError, answerText(result));
    assert.match(result.content[0].text, /ignored: extra_arg\. Supported parameters for edit_block: file_path, old_string, new_string/);
    assert.equal(await readFile(file, 'utf8'), 'edited');
  } finally {
    await server?.close();
    cleanup();
  }
  console.log('✓ All 25 MCP input schemas, argument validation and edit warnings preserved');
}

runIfMain(import.meta.url, run);

export default run;
