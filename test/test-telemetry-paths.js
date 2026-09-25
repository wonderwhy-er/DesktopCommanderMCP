/**
 * What a failed tool call sends to telemetry: every path in the error text is
 * replaced whole, spaces and all, and the rest of the message is kept.
 *
 * Runs the real tools/call handler in this process with telemetry on, and
 * records each payload instead of sending it (https.request is replaced before
 * anything is sent). The paths are outside the home folder and end in a name
 * with a space, the case a pattern can't tell apart from the text after it.
 */
import assert from 'assert';
import { EventEmitter } from 'events';
import https from 'https';
import { syncBuiltinESMExports } from 'module';
import os from 'os';
import path from 'path';
import { runIfMain } from './helpers/run-if-main.js';

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

const { server } = await import('../dist/server.js');
const { configManager } = await import('../dist/config-manager.js');

// Outside the home folder: at the root of the drive the temporary folder is on
const ROOT = path.parse(os.tmpdir()).root;
const ALLOWED = path.join(ROOT, 'dc-telemetry-test', 'allowed folder');
const REQUESTED = path.join(ROOT, 'var', 'log', 'private notes.txt');

/** The error texts of the events named `name` sent so far, waiting up to 5 s for the first one. */
async function sentErrors(name) {
  for (let waited = 0; waited < 5000; waited += 50) {
    const errors = sent.flatMap((payload) => payload.events)
      .filter((event) => event.name === name && event.params.error !== undefined)
      .map((event) => event.params.error);
    if (errors.length > 0) return errors;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return [];
}

async function testDeniedPath() {
  await configManager.setValue('telemetryEnabled', true);
  await configManager.setValue('allowedDirectories', [ALLOWED]);
  const callTool = server._requestHandlers.get('tools/call');

  const answer = await callTool({ method: 'tools/call', params: { name: 'read_file', arguments: { path: REQUESTED } } }, {});

  // The AI's answer is unchanged: it names the path
  assert.strictEqual(answer.isError, true, 'read_file outside the allowed folders should fail');
  assert.ok(answer.content[0].text.includes(`Path not allowed: ${REQUESTED}`), `The answer should name the path, got: ${answer.content[0].text}`);

  // Telemetry gets the same message with each path replaced whole
  const errors = await sentErrors('server_request_error');
  assert.deepStrictEqual(errors, ['Path not allowed: [PATH]. Must be within one of these directories: [PATH]']);

  // No event carries any piece of either path
  const everything = JSON.stringify(sent);
  for (const piece of ['private notes', 'notes.txt', 'allowed folder', 'dc-telemetry-test']) {
    assert.ok(!everything.includes(piece), `Telemetry should not contain "${piece}", sent: ${everything}`);
  }
}

async function runTests() {
  try {
    await testDeniedPath();
    console.log('✓ a denied path is replaced whole in telemetry, and the answer still names it');
    return true;
  } catch (error) {
    console.error('✗', error.message);
    return false;
  }
}

runIfMain(import.meta.url, runTests);
