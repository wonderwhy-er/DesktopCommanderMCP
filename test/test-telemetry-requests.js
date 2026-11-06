/** The telemetry stand-in acknowledges both Node request overloads and exposes missing callbacks. */
import assert from 'node:assert/strict';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { captureTelemetryRequests } from './helpers/telemetry-requests.js';
import { runIfMain } from './helpers/run-if-main.js';

export default async function run() {
  const original = https.request;
  let missing = 0;
  try {
    const sent = captureTelemetryRequests(() => missing++);
    for (const shape of ['url-options-callback', 'options-callback']) {
      let response;
      const callback = value => { response = value; };
      const request = shape === 'url-options-callback'
        ? https.request('https://telemetry.example.test/collect', { method: 'POST' }, callback)
        : https.request({ hostname: 'telemetry.example.test', method: 'POST' }, callback);
      request.write(JSON.stringify({ events: [{ name: shape }] }));
      request.end();
      assert.equal(response?.statusCode, 204, shape + ' receives its actual response callback');
    }
    const noCallback = https.request('https://telemetry.example.test/collect', { method: 'POST' });
    noCallback.write(JSON.stringify({ events: [] }));
    noCallback.end();
    assert.equal(missing, 1, 'an absent response callback is observed rather than silently counted as valid');
    assert.deepEqual(sent.map(payload => payload.events.map(event => event.name)),
      [['url-options-callback'], ['options-callback'], []]);
  } finally {
    https.request = original;
    syncBuiltinESMExports();
  }
}
runIfMain(import.meta.url, run);
