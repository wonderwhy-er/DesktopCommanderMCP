#!/usr/bin/env node

/**
 * The config editor shows the on/off settings as the server reads them from
 * config.json.
 *
 * telemetryEnabled and toolCallAuditLogEnabled count as on unless config.json
 * says false. A config.json written before a setting existed has no value for
 * it, which the server reads as on, and one edited by hand can say " FALSE ",
 * which it reads as off; the editor must show the same. The test edits
 * config.json by hand, starts the server, opens the editor page as a client
 * gets it (getConfigEditorResourceText()) in jsdom, answers the host's side of
 * the connection, and gives the editor the server's get_config answer.
 *
 * Runs as part of `npm test`, or standalone:
 *   node test/run-all-tests.js test-config-editor-missing-setting.js
 */
import assert from 'assert';
import fs from 'fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { CONFIG_FILE } from '../dist/config.js';
import { getConfigEditorResourceText } from '../dist/ui/resources.js';
import { connectToServer, closeClient } from './helpers/mcp-client.js';
import { runIfMain, skip } from './helpers/run-if-main.js';
import { isTestHome } from './helpers/test-env.js';
import { waitUntil } from './helpers/wait.js';

/** The server's get_config answer */
async function getConfig() {
  const client = await connectToServer('config-editor-test');
  try {
    return await client.callTool({ name: 'get_config', arguments: {} });
  } finally {
    await closeClient(client);
  }
}

/** Opens the editor with get_config answering `configAnswer`, and returns the keys whose switch is on */
async function keysShownOn(configAnswer) {
  const entries = configAnswer.structuredContent.entries;
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
        callTool: async (name) => (name === 'get_config' ? configAnswer : { content: [] }),
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
    const booleans = entries.filter((entry) => entry.valueType === 'boolean').length;
    await waitUntil(() => switches().length === booleans, 10_000, 'the editor shows a switch for each on/off setting');
    return switches().filter((input) => input.checked).map((input) => entries[Number(input.dataset.keyIndex)].key);
  } finally {
    dom.window.close();
  }
}

async function runTests() {
  if (!isTestHome()) {
    return skip('test-config-editor-missing-setting.js edits config.json in the home; run it through the runner: node test/run-all-tests.js test-config-editor-missing-setting.js');
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

  // The runner's home is new, so the first start writes a fresh config.json
  await getConfig();
  // Edited by hand while no server runs
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  config.telemetryEnabled = ' FALSE ';
  delete config.toolCallAuditLogEnabled;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  const shownOn = await keysShownOn(await getConfig());

  await test('" FALSE " written by hand in config.json shows as off, and a setting missing from it as on', () => {
    assert.deepStrictEqual(shownOn, ['toolCallAuditLogEnabled']);
  });

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`);
    return false;
  }
  console.log('\nThe config editor shows the on/off settings as the server reads them from config.json');
  return true;
}

runIfMain(import.meta.url, runTests);

export default runTests;
