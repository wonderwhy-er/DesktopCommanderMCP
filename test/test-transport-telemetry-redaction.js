/**
 * A transport event (captureTransport(), the remote device's receipt and
 * execution checkpoints) goes through the same redaction as every other event:
 * a known folder in any of its fields (an allowed folder, the home folder) is
 * sent as [PATH] (the name after it kept, as for every event's fields other
 * than free text), and its other fields are sent as they are.
 *
 * Records each telemetry payload instead of sending it (https.request is
 * replaced before anything is sent), with telemetry on. The test changes
 * settings in the home, so it runs only in a test home (the runner's), and
 * leaves every setting it changes as it found it.
 */
import assert from 'assert';
import { EventEmitter } from 'events';
import https from 'https';
import { syncBuiltinESMExports } from 'module';
import os from 'os';
import path from 'path';
import { runIfMain, skip } from './helpers/run-if-main.js';
import { isTestHome } from './helpers/test-env.js';

// Every telemetry payload this process would send
const sent = [];
https.request = (options, callback) => {
  const chunks = [];
  const req = new EventEmitter();
  req.write = (data) => { chunks.push(String(data)); return true; };
  req.setTimeout = () => req;
  req.destroy = () => {};
  req.end = () => {
    sent.push(JSON.parse(chunks.join('')));
    const res = new EventEmitter();
    res.statusCode = 204;
    res.resume = () => res;
    callback?.(res);
    setImmediate(() => res.emit('end'));
  };
  return req;
};
syncBuiltinESMExports();
delete process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY;

const { captureTransport } = await import('../dist/utils/capture.js');
const { configManager } = await import('../dist/config-manager.js');

// Outside the home folder: at the root of the drive the temporary folder is on
const ALLOWED = path.join(path.parse(os.tmpdir()).root, 'dc-transport-test', 'allowed folder');

/** The params of the events named `name` sent so far, waiting up to 5 s for the first one. */
async function sentEvents(name) {
  for (let waited = 0; waited < 5000; waited += 50) {
    const events = sent.flatMap((payload) => payload.events).filter((event) => event.name === name).map((event) => event.params);
    if (events.length > 0) return events;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return [];
}

async function testKnownPathsRedacted() {
  await configManager.setValue('telemetryEnabled', true);
  await configManager.setValue('allowedDirectories', [ALLOWED]);
  const fields = {
    call_id: 'call-1',
    device_id: 'device-1',
    stage: 'operation_start',
    tool_name: 'read_file',
    operation: `read ${path.join(ALLOWED, 'notes.txt')}`,
    operation_id: path.join(os.homedir(), 'private notes.txt'),
    schema_version: 1,
  };
  await captureTransport('operation_start', fields);
  const [params] = await sentEvents('operation_start');
  assert.ok(params, `the transport event should be sent, sent: ${JSON.stringify(sent)}`);
  const everything = JSON.stringify(sent).toLowerCase();
  for (const folder of [ALLOWED, os.homedir()]) {
    assert.ok(!everything.includes(JSON.stringify(folder).slice(1, -1).toLowerCase()), `a transport event sent the folder ${folder} unredacted: ${JSON.stringify(params)}`);
  }
  // As for every event's fields other than free text: the known folder is replaced, the name after it kept
  assert.strictEqual(params.operation, `read [PATH]${path.sep}notes.txt`, 'the allowed folder in a transport field should be sent as [PATH]');
  assert.strictEqual(params.operation_id, `[PATH]${path.sep}private notes.txt`, 'the home folder in a transport field should be sent as [PATH]');
  assert.deepStrictEqual(
    { call_id: params.call_id, device_id: params.device_id, stage: params.stage, tool_name: params.tool_name, schema_version: params.schema_version },
    { call_id: 'call-1', device_id: 'device-1', stage: 'operation_start', tool_name: 'read_file', schema_version: 1 },
    'the other transport fields should be sent as they are');
}

async function runTests() {
  if (!isTestHome()) {
    return skip('test-transport-telemetry-redaction.js changes config.json: it runs only in a test home (node test/run-all-tests.js test-transport-telemetry-redaction.js)');
  }
  const found = {
    telemetryEnabled: await configManager.getValue('telemetryEnabled'),
    allowedDirectories: await configManager.getValue('allowedDirectories'),
  };
  let passed = true;
  try {
    await testKnownPathsRedacted();
    console.log('✓ a transport event sends known folders as [PATH], and its other fields as they are');
  } catch (error) {
    console.error('✗', error.message);
    passed = false;
  } finally {
    await configManager.setValue('telemetryEnabled', found.telemetryEnabled);
    await configManager.setValue('allowedDirectories', found.allowedDirectories);
  }
  const left = {
    telemetryEnabled: await configManager.getValue('telemetryEnabled'),
    allowedDirectories: await configManager.getValue('allowedDirectories'),
  };
  try {
    assert.deepStrictEqual(left, found, 'the test must leave the settings as it found them');
    console.log('✓ the settings are left as they were found');
  } catch (error) {
    console.error('✗', error.message);
    passed = false;
  }
  return passed;
}

runIfMain(import.meta.url, runTests);
