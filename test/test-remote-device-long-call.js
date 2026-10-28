/**
 * The device (`desktop-commander remote`) runs each Remote tool call on its
 * local Desktop Commander and waits for the answer. A call whose work takes
 * longer than a minute, such as reading a file from a slow network source,
 * must get its result. With the MCP SDK's default time limit of 60 seconds,
 * the device gave up on such a call with "MCP error -32001: Request timed out",
 * and that error became the call's stored result while the work went on.
 *
 * Starts the local server through the device's own integration and reads a URL
 * from a local web server that sends the file's text after SLOW_READ_MS.
 * Takes about 65 seconds.
 */
import assert from 'assert';
import http from 'http';
import { DesktopCommanderIntegration } from '../dist/remote-device/desktop-commander-integration.js';
import { runIfMain } from './helpers/run-if-main.js';

/** How long the slow file takes to arrive: past the MCP SDK's default 60 seconds */
const SLOW_READ_MS = 65_000;
const TEXT = 'the slow file has arrived';

export default async function runTests() {
  // The headers go at once and the text after SLOW_READ_MS, because read_file's
  // own 30-second limit for a URL covers only the wait for the headers
  let textTimer;
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.flushHeaders();
    textTimer = setTimeout(() => response.end(TEXT), SLOW_READ_MS);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const integration = new DesktopCommanderIntegration();
  try {
    await integration.initialize();
    const started = Date.now();
    const answer = await integration.callClientTool('read_file', {
      path: `http://127.0.0.1:${server.address().port}/slow.txt`,
      isUrl: true,
    }).catch((error) => error);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    assert(!(answer instanceof Error),
      `a read that takes ${SLOW_READ_MS / 1000} s should get its result, but the device gave up after ${seconds} s: ${answer.message}`);
    const text = answer.content?.[0]?.text ?? '';
    assert(text.includes(TEXT), `the read should answer the file's text, got after ${seconds} s:\n${JSON.stringify(answer)}`);
    console.log(`✓ a device call that takes ${seconds} s gets its result`);
  } finally {
    clearTimeout(textTimer);
    await integration.shutdown();
    server.closeAllConnections();
    server.close();
  }
  return true;
}

runIfMain(import.meta.url, runTests);
