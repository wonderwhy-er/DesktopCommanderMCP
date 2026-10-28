#!/usr/bin/env node

/**
 * The config editor shows a boolean setting that config.json doesn't have as on,
 * because the server treats it as on.
 *
 * The server counts telemetryEnabled and toolCallAuditLogEnabled as on unless
 * config.json says false. A config.json written before a setting existed has no
 * value for it, so get_config sends that entry without a value, and the editor
 * showed its switch as off. The test opens the editor page as a client gets it
 * (getConfigEditorResourceText()) in jsdom, answers the host's side of the
 * connection, and answers get_config with every boolean setting missing, then
 * with every one false.
 *
 * Runs as part of `npm test`, or standalone:
 *   node test/test-config-editor-missing-setting.js
 */
import assert from 'assert';
import { JSDOM, VirtualConsole } from 'jsdom';
import { CONFIG_FIELD_DEFINITIONS } from '../dist/config-field-definitions.js';
import { getConfigEditorResourceText } from '../dist/ui/resources.js';
import { runIfMain } from './helpers/run-if-main.js';
import { waitUntil } from './helpers/wait.js';

const BOOLEAN_KEYS = Object.keys(CONFIG_FIELD_DEFINITIONS)
  .filter((key) => CONFIG_FIELD_DEFINITIONS[key].valueType === 'boolean');

/** Opens the editor with get_config answering `entries`, and returns the keys whose switch is on */
async function keysShownOn(entries) {
  // The page logs every message it sends and receives: show only its errors
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('error', (...args) => console.error(...args));
  virtualConsole.on('jsdomError', (error) => console.error(error));
  const dom = new JSDOM(await getConfigEditorResourceText(), {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.ResizeObserver = class { observe() {} disconnect() {} };
      // The editor calls tools through window.mcp when the host provides it
      window.mcp = {
        callTool: async (name) => (name === 'get_config' ? { structuredContent: { entries } } : { content: [] }),
      };
      // The host's side of the connection: the editor posts ui/initialize to its
      // parent, which is this window here, and waits for the host's answer
      window.addEventListener('message', ({ data }) => {
        if (data?.method !== 'ui/initialize') return;
        const result = { protocolVersion: data.params.protocolVersion, hostInfo: { name: 'test-host', version: '1.0.0' }, hostCapabilities: {}, hostContext: {} };
        window.dispatchEvent(new window.MessageEvent('message', { source: window, data: { jsonrpc: '2.0', id: data.id, result } }));
      });
    },
  });
  try {
    const switches = () => [...dom.window.document.querySelectorAll('input[data-action="toggle-boolean"]')];
    await waitUntil(() => switches().length === entries.length, 10_000, 'the editor shows a switch for each setting');
    return switches().filter((input) => input.checked).map((input) => entries[Number(input.dataset.keyIndex)].key);
  } finally {
    dom.window.close();
  }
}

async function runTests() {
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

  await test('a boolean setting missing from config.json shows as on', async () => {
    // get_config's answer drops a value config.json doesn't have
    const missing = BOOLEAN_KEYS.map((key) => ({ key, valueType: 'boolean', editable: true }));
    assert.deepStrictEqual(await keysShownOn(missing), BOOLEAN_KEYS);
  });

  await test('a boolean setting set to false shows as off', async () => {
    const off = BOOLEAN_KEYS.map((key) => ({ key, value: false, valueType: 'boolean', editable: true }));
    assert.deepStrictEqual(await keysShownOn(off), []);
  });

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`);
    return false;
  }
  console.log(`\nThe config editor shows ${BOOLEAN_KEYS.join(' and ')} as on when config.json has no value for them`);
  return true;
}

runIfMain(import.meta.url, runTests);

export default runTests;
