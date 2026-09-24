/**
 * The ceiling on one blocking process wait is a fixed constant, not a config
 * value: timeout_ms is the only knob callers have. Checks the ceiling the
 * product computes, that set_config_value refuses the old maxProcessWaitMs key
 * and get_config doesn't list it, and set_config_value's handling of number
 * fields (numeric strings stored as numbers, non-numbers rejected, null resets).
 * A wait the ceiling ends answers with the same status line as before.
 */
import assert from 'assert';
import { configManager } from '../dist/config-manager.js';
import { MAX_PROCESS_WAIT_MS } from '../dist/config.js';
import { getProcessWaitLimit } from '../dist/terminal-manager.js';
import { getConfig, setConfigValue } from '../dist/tools/config.js';
import { startProcess, interactWithProcess, forceTerminate } from '../dist/tools/improved-process-tools.js';
import { runIfMain } from './helpers/run-if-main.js';

async function testFixedCeiling() {
  console.log('\n--- Test 1: the wait ceiling is the fixed constant ---');
  assert.strictEqual(MAX_PROCESS_WAIT_MS, 60000);
  assert.deepStrictEqual(getProcessWaitLimit(MAX_PROCESS_WAIT_MS * 5),
    { waitMs: MAX_PROCESS_WAIT_MS, capMs: MAX_PROCESS_WAIT_MS, capped: true });
  assert.deepStrictEqual(getProcessWaitLimit(1000),
    { waitMs: 1000, capMs: MAX_PROCESS_WAIT_MS, capped: false });
  assert.deepStrictEqual(getProcessWaitLimit(MAX_PROCESS_WAIT_MS),
    { waitMs: MAX_PROCESS_WAIT_MS, capMs: MAX_PROCESS_WAIT_MS, capped: false });
  console.log(`ok: min(timeout_ms, ${MAX_PROCESS_WAIT_MS}ms)`);
}

async function testNotConfigurable() {
  console.log('\n--- Test 2: maxProcessWaitMs is not a config key ---');
  const response = await setConfigValue({ key: 'maxProcessWaitMs', value: 5000 });
  assert.strictEqual(response.isError, true);
  assert.match(response.content[0].text, /not configurable/);
  assert.strictEqual(await configManager.getValue('maxProcessWaitMs'), undefined);
  const keys = (await getConfig()).structuredContent.entries.map((entry) => entry.key);
  assert(!keys.includes('maxProcessWaitMs'), `get_config must not list it, got: ${keys.join(', ')}`);
  console.log('ok: set_config_value refuses it, get_config does not list it');
}

async function testNumberFields() {
  console.log('\n--- Test 3: set_config_value number fields ---');
  const key = 'fileReadLineLimit';
  let response = await setConfigValue({ key, value: '250' });
  assert.notStrictEqual(response.isError, true, response.content?.[0]?.text);
  assert.strictEqual(await configManager.getValue(key), 250);

  response = await setConfigValue({ key, value: 'many' });
  assert.strictEqual(response.isError, true);
  assert.match(response.content[0].text, /must be a number/);
  assert.strictEqual(await configManager.getValue(key), 250, 'a rejected value must not change the stored one');

  response = await setConfigValue({ key, value: null });
  assert.notStrictEqual(response.isError, true, response.content?.[0]?.text);
  assert.strictEqual(await configManager.getValue(key), null);
  console.log('ok: "250" stored as 250, "many" rejected, null clears it');
}

async function testCappedWaitAnswers() {
  console.log('\n--- Test 4: a wait the ceiling ends answers as before ---');
  // A small ceiling stands in for MAX_PROCESS_WAIT_MS so the test doesn't wait a minute
  const CAP_MS = 300;
  const started = await startProcess({ command: 'node -e "setTimeout(() => {}, 3000)"', timeout_ms: 5000 }, CAP_MS);
  const pid = started.structuredContent?.pid;
  assert.ok(pid > 0, `start_process should start node, got: ${started.content[0].text}`);
  try {
    assert.strictEqual(started.structuredContent.waitCapped, true, started.content[0].text);
    assert.ok(started.content[0].text.endsWith('\n⏳ Process is running. Use read_process_output to get more output.'),
      `start_process should end with the old status line, got: ${started.content[0].text}`);
  } finally {
    await forceTerminate({ pid });
  }

  const repl = await startProcess({ command: 'node -i', timeout_ms: 5000 });
  const replPid = repl.structuredContent?.pid;
  assert.ok(replPid > 0, `start_process should start the Node.js REPL, got: ${repl.content[0].text}`);
  try {
    const busy = await interactWithProcess(
      { pid: replPid, input: 'const t = Date.now(); while (Date.now() - t < 2000) {}', timeout_ms: 5000 }, CAP_MS);
    assert.strictEqual(busy.structuredContent.waitCapped, true, busy.content[0].text);
    assert.ok(busy.content[0].text.endsWith('\n⏱️ Response may be incomplete (timeout reached)'),
      `interact_with_process should end with the old status line, got: ${busy.content[0].text}`);
  } finally {
    await forceTerminate({ pid: replPid });
  }
  console.log('ok: start_process and interact_with_process keep their old status lines');
}

async function runAllTests() {
  await testFixedCeiling();
  await testNotConfigurable();
  await testNumberFields();
  await testCappedWaitAnswers();
  console.log('\n✅ process wait ceiling and config number tests passed');
}

runIfMain(import.meta.url, runAllTests);

export default runAllTests;
