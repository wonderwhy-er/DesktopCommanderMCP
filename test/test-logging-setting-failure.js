/**
 * Logging must contain an unexpected audit-setting rejection after config has
 * initialized. This injects that conditional fault; ordinary startup I/O is
 * already caught by ConfigManager and is not claimed to reject here.
 *
 * Run through test/run-all-tests.js so files and config stay in its test home.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { runIfMain, skip } from './helpers/run-if-main.js';
import { isTestHome } from './helpers/test-env.js';

/** Drain the rejection-reporting turn, without a sleep or elapsed-time assertion. */
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

/** Exercise real tool handling and both log writers under one isolated audit-read fault. */
async function runTests() {
  if (!isTestHome()) return skip('logging fault checks require the runner test home');
  const { server } = await import('../dist/server.js');
  const { configManager } = await import('../dist/config-manager.js');
  const { toolHistory } = await import('../dist/utils/toolHistory.js');
  const { trackToolCall } = await import('../dist/utils/trackTools.js');
  const { usageTracker } = await import('../dist/utils/usageTracker.js');
  const { TOOL_CALL_FILE } = await import('../dist/config.js');
  const logFiles = [TOOL_CALL_FILE, path.join(path.dirname(TOOL_CALL_FILE), 'tool-history.jsonl')];
  const healthyFile = path.join(path.dirname(TOOL_CALL_FILE), 'logging-fault-healthy.txt');
  const originalPrompt = usageTracker.shouldPromptForFeedback;
  const failures = [];

  /** Keep all fault observations visible even if one boundary fails. */
  async function test(name, body) {
    try { await body(); console.log(`PASS ${name}`); }
    catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
  }

  /** Record only the audit files; unrelated config and usage persistence is allowed. */
  const logContents = () => logFiles.map((file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);

  /** Reject only the audit key and restore every patched boundary after reporting its event-loop turn. */
  async function withAuditReadFailure(body) {
    const originalGetValue = configManager.getValue;
    const originalError = console.error;
    const unhandled = [];
    const errors = [];
    let auditReads = 0;
    const observeUnhandled = (reason) => { unhandled.push(reason); };
    process.on('unhandledRejection', observeUnhandled);
    console.error = (...args) => { errors.push(args.map(String).join(' ')); };
    configManager.getValue = async function (key) {
      if (key === 'toolCallAuditLogEnabled') {
        auditReads++;
        throw new Error('planted audit-setting read failure');
      }
      return originalGetValue.call(this, key);
    };
    try {
      await body({ unhandled, errors, auditReads: () => auditReads });
    } finally {
      await nextTurn();
      configManager.getValue = originalGetValue;
      console.error = originalError;
      process.removeListener('unhandledRejection', observeUnhandled);
    }
  }

  try {
    await configManager.init();
    await configManager.setValue('toolCallAuditLogEnabled', false);
    usageTracker.shouldPromptForFeedback = async () => false;
    fs.writeFileSync(healthyFile, 'healthy tool result\n');
    const callTool = server._requestHandlers.get('tools/call');
    const request = { method: 'tools/call', params: { name: 'read_file', arguments: { path: healthyFile } } };
    const expected = await callTool(request, {});
    assert.notEqual(expected.isError, true);
    const beforeLogs = logContents();

    await test('a history setting rejection preserves the tool answer, memory and disk privacy', async () => {
      const beforeEntries = toolHistory.getRecentCalls({ toolName: 'read_file', maxResults: 1000 }).length;
      await withAuditReadFailure(async ({ unhandled, auditReads }) => {
        const answer = await callTool(request, {});
        await nextTurn();
        assert.deepEqual(answer, expected, 'logging must not replace a successful tool result');
        assert.ok(auditReads() >= 2, 'both audit writers must meet the controlled fault');
        assert.equal(toolHistory.getRecentCalls({ toolName: 'read_file', maxResults: 1000 }).length, beforeEntries + 1);
        assert.equal(toolHistory.getStats().queuedWrites, 0, 'unknown audit state must not queue disk history');
        assert.deepEqual(logContents(), beforeLogs, 'unknown audit state must not write either audit file');
        assert.equal(unhandled.length, 0, 'history logging rejection must be consumed at its fire-and-forget boundary');
      });
    });

    await test('the call logger already contains the same rejected setting read', async () => {
      await withAuditReadFailure(async ({ unhandled, errors, auditReads }) => {
        await trackToolCall('planted_tool', { purpose: 'audit-state fault' });
        await nextTurn();
        assert.equal(auditReads(), 1);
        assert.equal(unhandled.length, 0);
        assert.ok(errors.some((line) => line.includes('Error logging tool call:')));
        assert.deepEqual(logContents(), beforeLogs);
      });
    });
  } finally {
    usageTracker.shouldPromptForFeedback = originalPrompt;
    await toolHistory.cleanup();
    await server.close();
  }
  return failures.length === 0;
}

runIfMain(import.meta.url, runTests);
export default runTests;
