/** Browser acquisition is a PDF-render side effect, never a startup side effect. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServerRecordingModules } from './helpers/server-modules.js';
import { callToolOnceLoaded } from './helpers/heavy-packages.js';
import { isTestHome } from './helpers/test-env.js';
import { runIfMain } from './helpers/run-if-main.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const chromeDir = path.join(os.homedir(), '.claude-server-commander', 'puppeteer-cache', 'chrome');
const staleBuild = path.join(chromeDir, 'test-100.0.0.0');
const currentBuild = path.join(chromeDir, 'test-101.0.0.0');

async function main() {
  assert(isTestHome(), 'Run this integration test using the isolated test runner');
  const server = await startServerRecordingModules();
  try {
    assert(fs.existsSync(staleBuild) && fs.existsSync(currentBuild),
      'test setup must install two inert Chrome-cache fixtures');
    // The helper seeds Chrome before it starts the actual MCP stdio server.
    // A previous eager startup check deleted the older fixture after initialize.
    await wait(700);
    assert(fs.existsSync(staleBuild), 'MCP startup unexpectedly acquired Chrome and pruned its cache');
    assert(fs.existsSync(currentBuild), 'MCP startup unexpectedly touched active Chrome cache');

    // These requests do not need a real Chrome binary. The fixture is inert;
    // Chrome launch can fail, but acquisition itself must run after write_pdf.
    const calls = ['first', 'second'].map((name) =>
      callToolOnceLoaded(server.client, {
        name: 'write_pdf',
        arguments: {
          path: path.join(os.homedir(), `on-demand-${name}.pdf`),
          content: '# On-demand browser lookup\n',
        },
      }, { timeoutMs: 45_000 }),
    );
    const results = await Promise.all(calls);
    assert.strictEqual(results.length, 2, 'both concurrent requests must terminate');
    assert(!fs.existsSync(staleBuild), 'PDF request did not trigger cached Chrome acquisition');
    assert(fs.existsSync(currentBuild), 'acquisition must preserve the selected Chrome build');
    console.log('MCP startup preserves Chrome cache; concurrent PDF calls acquire on demand.');
  } finally {
    await server.close();
  }
}

runIfMain(import.meta.url, main);
