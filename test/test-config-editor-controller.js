import assert from 'node:assert/strict';
import { createConfigEditorController } from '../dist/ui/config-editor/src/app.js';
import { runIfMain } from './helpers/run-if-main.js';

const entry = (value, valueType = 'string', editable = true) => ({
  key: 'testSetting', value, valueType, editable,
});
const payload = (...entries) => ({ entries });

function fixture(initial, respond = async () => ({})) {
  const calls = [];
  const events = [];
  const controller = createConfigEditorController(async (name, args) => {
    calls.push({ name, args });
    return respond(name, args);
  }, (name, params) => events.push({ name, params }));
  controller.setPayload(initial);
  return { controller, calls, events };
}

async function testSelectionAndRejectedChanges() {
  const f = fixture(null);
  assert.equal(f.controller.state.selectedKey, null);
  assert.equal((await f.controller.apply()).tooltip.tone, 'error');

  f.controller.setPayload(payload(entry('locked', 'string', false)));
  f.controller.setDraftValue('changed');
  assert.match((await f.controller.apply()).tooltip.message, /read-only/);

  for (const [type, value, draft, message] of [
    ['number', 5, '', /valid number/],
    ['number', 5, 'Infinity', /valid number/],
    ['boolean', true, 'yes', /true or false/],
    ['null', null, 'undefined', /exactly null/],
    ['array', [], '[broken', /valid JSON arrays/],
    ['array', [], '[1]', /only strings/],
  ]) {
    f.controller.setPayload(payload(entry(value, type)));
    f.controller.setDraftValue(draft);
    const result = await f.controller.apply();
    assert.equal(result.ok, false, `${type}: invalid input must fail`);
    assert.equal(result.tooltip.tone, 'error');
    assert.match(result.tooltip.message, message);
  }
  assert.deepEqual(f.calls, [], 'invalid and readonly changes must never write');
  assert.deepEqual(f.events, [], 'validation failures must not claim a server update');

  f.controller.setPayload(payload(entry('first'), { key: 'second', value: 2, valueType: 'number', editable: true }));
  f.controller.setSelection('second');
  assert.equal(f.controller.state.draftValue, '2');
  f.controller.setPayload(payload(entry('replacement')));
  assert.equal(f.controller.state.selectedKey, 'testSetting');
  assert.equal(f.controller.state.draftValue, 'replacement');
  f.controller.setPayload(payload());
  assert.equal(f.controller.state.selectedKey, null);
  assert.equal(f.controller.state.draftValue, '');
}

async function testUnchangedValuesDoNotWrite() {
  for (const [value, type, draft, normalized] of [
    [5, 'number', ' 5 ', '5'],
    [true, 'boolean', ' TRUE ', 'true'],
    [null, 'null', ' NULL ', 'null'],
    [['a', 'b'], 'array', '["a", "b"]', 'a\nb'],
  ]) {
    const f = fixture(payload(entry(value, type)));
    f.controller.setDraftValue(draft);
    assert.deepEqual(await f.controller.apply(), { ok: false });
    assert.equal(f.controller.state.draftValue, normalized);
    assert.deepEqual(f.calls, [], 'equivalent values must not invoke tools');
    assert.deepEqual(f.events, []);
  }
}

async function testChangedValuesWriteThenRefresh() {
  for (const [oldValue, type, draft, expected] of [
    ['old', 'string', 'line one\nline two', 'line one line two'],
    [1, 'number', ' 2.5 ', 2.5],
    [true, 'boolean', ' FALSE ', false],
    [['old'], 'array', '', []],
    [[], 'array', ' first \n\n second ', ['first', 'second']],
    [[], 'array', '["first","second"]', ['first', 'second']],
  ]) {
    const refreshed = entry(expected, type);
    const f = fixture(payload(entry(oldValue, type)), async (name) => name === 'get_config'
      ? { structuredContent: payload(refreshed) } : {});
    f.controller.setDraftValue(draft);
    assert.deepEqual(await f.controller.apply(), { ok: true });
    assert.deepEqual(f.calls, [
      { name: 'set_config_value', args: { key: 'testSetting', value: expected, origin: 'ui' } },
      { name: 'get_config', args: { origin: 'ui' } },
    ]);
    assert.deepEqual(f.controller.state.payload.entries[0].value, expected);
    assert.equal(f.controller.state.draftValue, Array.isArray(expected) ? expected.join('\n') : String(expected));
    assert.deepEqual(f.events.map((e) => e.name), ['config_update_success']);
    assert.equal(f.events[0].params.tool_name, 'set_config_value');
  }
}

async function testWriteMustFinishBeforeRefresh() {
  let releaseWrite;
  const pendingWrite = new Promise((resolve) => { releaseWrite = resolve; });
  const f = fixture(payload(entry('before')), async (name) => name === 'set_config_value'
    ? pendingWrite : { structuredContent: payload(entry('canonical server value')) });
  f.controller.setDraftValue('requested value');
  const applying = f.controller.apply();
  assert.deepEqual(f.calls.map((call) => call.name), ['set_config_value']);
  assert.deepEqual(f.events, [], 'success must await the write response');
  releaseWrite({});
  assert.equal((await applying).ok, true);
  assert.equal(f.controller.state.draftValue, 'canonical server value', 'refresh must use server data, not the draft');
  assert.deepEqual(f.calls.map((call) => call.name), ['set_config_value', 'get_config']);
}

async function testToolAndTransportFailures() {
  for (const [response, expectedMessage] of [
    [{ isError: true, content: [{ type: 'text', text: 'Write refused' }] }, 'Write refused'],
    [{ isError: true }, 'Failed to update testSetting.'],
  ]) {
    const f = fixture(payload(entry('before')), async () => response);
    f.controller.setDraftValue('after');
    assert.deepEqual(await f.controller.apply(), { ok: false, tooltip: { message: expectedMessage, tone: 'error' } });
    assert.deepEqual(f.calls.map((c) => c.name), ['set_config_value'], 'failed writes must not refresh');
    assert.equal(f.controller.state.payload.entries[0].value, 'before');
    assert.deepEqual(f.events.map((e) => e.name), ['config_update_failed']);
    assert.equal(f.events[0].params.error_stage, 'set_config_value');
  }

  const rejected = fixture(payload(entry('before')), async () => { throw new Error('Connection lost'); });
  rejected.controller.setDraftValue('after');
  assert.deepEqual(await rejected.controller.apply(), {
    ok: false, tooltip: { message: 'Failed to apply value: Connection lost', tone: 'error' },
  });
  assert.deepEqual(rejected.calls.map((c) => c.name), ['set_config_value']);
  assert.deepEqual(rejected.events.map((e) => e.name), ['config_update_failed']);
  assert.equal(rejected.events[0].params.error_stage, 'transport');

  const refreshFailed = fixture(payload(entry('before')), async (name) => name === 'get_config'
    ? { isError: true, content: [{ type: 'text', text: 'Refresh refused' }] } : {});
  refreshFailed.controller.setDraftValue('after');
  assert.deepEqual(await refreshFailed.controller.apply(), {
    ok: false, tooltip: { message: 'Refresh refused', tone: 'error' },
  });
  assert.deepEqual(refreshFailed.calls.map((c) => c.name), ['set_config_value', 'get_config']);
  assert.equal(refreshFailed.controller.state.payload.entries[0].value, 'before');
  assert.deepEqual(refreshFailed.events.map((e) => e.name), ['config_update_success'], 'write success is distinct from refresh failure');
}

export default async function runTests() {
  await testSelectionAndRejectedChanges();
  await testUnchangedValuesDoNotWrite();
  await testChangedValuesWriteThenRefresh();
  await testWriteMustFinishBeforeRefresh();
  await testToolAndTransportFailures();
  console.log('✓ Config controller validation, write/refresh ordering and failure handling');
  return true;
}

runIfMain(import.meta.url, runTests);
