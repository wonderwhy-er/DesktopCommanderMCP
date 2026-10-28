#!/usr/bin/env node

/**
 * The toolCallAuditLogEnabled setting stops tool calls being written to disk (#506).
 *
 * Every tool call, with its arguments, is written to
 * ~/.claude-server-commander/claude_tool_call.log, and with a preview of its
 * result to tool-history.jsonl, which get_recent_tool_calls reads back after a
 * restart. With toolCallAuditLogEnabled set to false, neither file gets new
 * calls, and get_recent_tool_calls still lists the calls made since the server
 * started. The checks run on the real server (dist/index.js over stdio), in the
 * runner's temporary home.
 *
 * Runs as part of `npm test`, or standalone:
 *   node test/run-all-tests.js test-tool-call-audit-log.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { TOOL_CALL_FILE } from '../dist/config.js';
import { answerText, connectToServer, closeClient } from './helpers/mcp-client.js';
import { runIfMain, skip } from './helpers/run-if-main.js';
import { createTempDir, isTestHome } from './helpers/test-env.js';
import { waitUntil } from './helpers/wait.js';

const LOG_FILES = [TOOL_CALL_FILE, path.join(path.dirname(TOOL_CALL_FILE), 'tool-history.jsonl')];
// Each call writes a file with its own name, so a log line shows which call it records
const BY_DEFAULT = 'written-with-a-fresh-config.txt';
const LOG_OFF = 'written-with-the-log-off.txt';
const LOG_ON_AGAIN = 'written-with-the-log-on-again.txt';

/** The log files that have a line with `text` */
function logsWith(text) {
  return LOG_FILES.filter((file) => {
    try {
      return fs.readFileSync(file, 'utf8').includes(text);
    } catch {
      return false;
    }
  });
}

async function runTests() {
  if (!isTestHome()) {
    return skip('test-tool-call-audit-log.js writes the logs in the home; run it through the runner: node test/run-all-tests.js test-tool-call-audit-log.js');
  }

  const failures = [];
  async function test(name, fn) {
    try {
      await fn();
      console.log(`✅ PASS  ${name}`);
    } catch (error) {
      failures.push(name);
      console.error(`🔴 FAIL  ${name}\n     ${error.message}`);
    }
  }

  const project = createTempDir('dc-tool-call-audit-log-');
  // The runner's home is new, so the server starts with a fresh config
  const client = await connectToServer('tool-call-audit-log-test');
  try {
    const call = (name, args) => client.callTool({ name, arguments: args });
    const write = (fileName) => call('write_file', { path: path.join(project, fileName), content: 'text\n' });

    await write(BY_DEFAULT);
    const turnedOff = await call('set_config_value', { key: 'toolCallAuditLogEnabled', value: false });
    await write(LOG_OFF);
    const recent = await call('get_recent_tool_calls', { maxResults: 10 });
    await call('set_config_value', { key: 'toolCallAuditLogEnabled', value: true });
    await write(LOG_ON_AGAIN);
    // Both files are written in call order, so once they have the last call,
    // a line for any earlier call would be there too
    await waitUntil(() => logsWith(LOG_ON_AGAIN).length === LOG_FILES.length, 10_000, 'the call is in both log files');

    await test('with a fresh config, a call is written to both log files', () => {
      assert.deepStrictEqual(logsWith(BY_DEFAULT), LOG_FILES);
    });

    await test('with toolCallAuditLogEnabled off, a call is written to neither log file, and get_recent_tool_calls lists it', () => {
      assert.notStrictEqual(turnedOff.isError, true, `set_config_value failed: ${answerText(turnedOff)}`);
      assert.deepStrictEqual(logsWith(LOG_OFF), [], 'a log file got the call made with toolCallAuditLogEnabled off');
      assert(answerText(recent).includes(LOG_OFF), `get_recent_tool_calls doesn't list the call made with toolCallAuditLogEnabled off:\n${answerText(recent)}`);
    });

    await test('with toolCallAuditLogEnabled on again, the next call is written to both log files', () => {
      assert.deepStrictEqual(logsWith(LOG_ON_AGAIN), LOG_FILES);
    });
  } finally {
    await closeClient(client);
    fs.rmSync(project, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`);
    return false;
  }
  console.log('\nWith toolCallAuditLogEnabled off, tool calls are written to neither log file');
  return true;
}

runIfMain(import.meta.url, runTests);

export default runTests;
