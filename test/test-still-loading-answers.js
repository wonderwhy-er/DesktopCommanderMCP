/**
 * What a tool call answers while the Excel, DOCX or PDF support it needs is
 * still loading (#777), on the server in this process, where nothing has
 * loaded that support yet:
 * - the answer names the file, but no telemetry event does: the answer was
 *   also sent as the call's error, file name included, on every retry
 * - read_file of a URL ending in .docx fetches the URL and never uses DOCX
 *   support, so it isn't refused while that support loads
 *
 * Telemetry is caught the way test-telemetry-paths.js catches it.
 */
import assert from 'assert';
import { EventEmitter } from 'events';
import http from 'http';
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

const { server } = await import('../dist/server.js');

const text = (result) => (result.content ?? []).map((item) => item.text ?? '').join('\n');
const callTool = (name, args) =>
  server._requestHandlers.get('tools/call')({ method: 'tools/call', params: { name, arguments: args } }, {});

/** Waits until telemetry has sent an event named `name` (or 5 s) */
async function waitForEvent(name) {
  for (let waited = 0; waited < 5000; waited += 50) {
    if (sent.some((payload) => payload.events.some((event) => event.name === name))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function testUrlIsNotRefused() {
  const urlServer = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' }).end('ZebraQuartz from a URL');
  });
  await new Promise((resolve) => urlServer.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${urlServer.address().port}/report.docx`;
    const answer = await callTool('read_file', { path: url, isUrl: true });
    assert(/ZebraQuartz from a URL/.test(text(answer)),
      `read_file of a URL ending in .docx, while DOCX support is still loading, should fetch the URL (it never uses DOCX support); it answered: ${text(answer)}`);
    console.log('✓ read_file of a URL ending in .docx fetches it while DOCX support is still loading');
  } finally {
    urlServer.close();
  }
}

async function testFileNameNotInTelemetry() {
  const answer = await callTool('read_file', { path: path.join(os.tmpdir(), 'salary-2026.xlsx') });
  assert(answer.isError === true && /Can't read salary-2026\.xlsx yet/.test(text(answer)),
    `setup: with Excel support still loading, read_file of salary-2026.xlsx should say it can't read it yet; it answered: ${text(answer)}`);
  await waitForEvent('server_call_tool');
  const leaking = sent.flatMap((payload) => payload.events).filter((event) => JSON.stringify(event).includes('salary-2026'));
  assert.deepStrictEqual(leaking, [],
    'the answer that a file can\'t be read yet names the file, and telemetry got that name: ' + JSON.stringify(leaking));
  console.log('✓ The answer names the file; no telemetry event does');
}

async function run() {
  if (!isTestHome()) {
    return skip('still-loading answers: the server in this process writes its config to the home; run through the test runner');
  }
  const failures = [];
  // The URL first: each case uses support nothing else here has loaded
  for (const test of [testUrlIsNotRefused, testFileNameNotInTelemetry]) {
    try {
      await test();
    } catch (error) {
      failures.push(test.name);
      console.log(`✗ ${test.name}: ${error.message}`);
    }
  }
  return failures.length === 0;
}

runIfMain(import.meta.url, run);

export default run;
