#!/usr/bin/env node

/**
 * The toolCallAuditLogEnabled setting stops tool calls being written to disk (#506).
 *
 * Every tool call, with its arguments, is written to
 * ~/.claude-server-commander/claude_tool_call.log, and with a preview of its
 * result to tool-history.jsonl, which get_recent_tool_calls reads back after a
 * restart. With toolCallAuditLogEnabled set to false, neither file gets new
 * calls, and get_recent_tool_calls still lists the calls made since the server
 * started. That holds for a "false" written by hand in config.json too, and a
 * config.json without the setting counts as on. The checks run on the real
 * server (dist/index.js over stdio), in the runner's temporary home.
 *
 * Runs as part of `npm test`, or standalone:
 *   node test/run-all-tests.js test-tool-call-audit-log.js
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { CONFIG_FILE, TOOL_CALL_FILE } from '../dist/config.js';
import { answerText, connectToServer, closeClient } from './helpers/mcp-client.js';
import { runIfMain, skip } from './helpers/run-if-main.js';
import { createTempDir, isTestHome } from './helpers/test-env.js';
import { waitUntil } from './helpers/wait.js';

const LOG_FILES = [TOOL_CALL_FILE, path.join(path.dirname(TOOL_CALL_FILE), 'tool-history.jsonl')];
// Each call writes a file with its own name, so a log line shows which call it records
const BY_DEFAULT = 'written-with-a-fresh-config.txt';
const LOG_OFF = 'written-with-the-log-off.txt';
const LOG_ON_AGAIN = 'written-with-the-log-on-again.txt';
const HAND_WRITTEN_FALSE = 'written-with-false-written-by-hand.txt';
const AFTER_HAND_WRITTEN_FALSE = 'written-after-turning-the-log-on.txt';
const SETTING_MISSING = 'written-with-the-setting-missing.txt';

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

/** Changes config.json as someone editing it by hand would, while no server runs */
function editConfig(change) {
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  change(config);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

/** Starts the server, runs `steps` with a function that calls its tools, and stops it */
async function withServer(steps) {
  const client = await connectToServer('tool-call-audit-log-test');
  try {
    return await steps((name, args) => client.callTool({ name, arguments: args }));
  } finally {
    await closeClient(client);
  }
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
  const write = (call, fileName) => call('write_file', { path: path.join(project, fileName), content: 'text\n' });
  const setLog = (call, value) => call('set_config_value', { key: 'toolCallAuditLogEnabled', value });
  // A server writes both files in call order, so once they have its last call,
  // a line for any earlier call would be there too
  const waitForLogs = (fileName) => waitUntil(() => logsWith(fileName).length === LOG_FILES.length, 10_000, `${fileName} is in both log files`);
  try {
    // The runner's home is new, so the first server starts with a fresh config
    const { turnedOff, recent } = await withServer(async (call) => {
      await write(call, BY_DEFAULT);
      const turnedOff = await setLog(call, false);
      await write(call, LOG_OFF);
      const recent = await call('get_recent_tool_calls', { maxResults: 10 });
      await setLog(call, true);
      await write(call, LOG_ON_AGAIN);
      await waitForLogs(LOG_ON_AGAIN);
      return { turnedOff, recent };
    });

    editConfig((config) => { config.toolCallAuditLogEnabled = 'false'; });
    await withServer(async (call) => {
      await write(call, HAND_WRITTEN_FALSE);
      await setLog(call, true);
      await write(call, AFTER_HAND_WRITTEN_FALSE);
      await waitForLogs(AFTER_HAND_WRITTEN_FALSE);
    });

    // As in a config.json written before the setting existed
    editConfig((config) => { delete config.toolCallAuditLogEnabled; });
    await withServer(async (call) => {
      await write(call, SETTING_MISSING);
      await waitForLogs(SETTING_MISSING);
    });

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

    await test('with "false" written by hand in config.json, a call is written to neither log file', () => {
      assert.deepStrictEqual(logsWith(HAND_WRITTEN_FALSE), [], 'a log file got the call made with "false" in config.json');
    });

    await test('with toolCallAuditLogEnabled missing from config.json, a call is written to both log files', () => {
      assert.deepStrictEqual(logsWith(SETTING_MISSING), LOG_FILES);
    });
  } finally {
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
