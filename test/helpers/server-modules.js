import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { isTestHome } from './test-env.js';
import { closeClient } from './close-client.js';
import { hookArgs } from './module-hooks.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER = path.join(PROJECT_ROOT, 'dist/index.js');
const PRELOAD = pathToFileURL(path.join(PROJECT_ROOT, 'test/fixtures/record-modules-preload.mjs')).href;
/** Records the server's imports; the preload records its requires */
const HOOKS = pathToFileURL(path.join(PROJECT_ROOT, 'test/fixtures/record-modules-hooks.mjs')).href;
/** Holds one package back, or makes it fail once (startServerRecordingModules({ holdPackage, failPackageOnce })) */
const PACKAGE_LOAD_HOOKS = pathToFileURL(path.join(PROJECT_ROOT, 'test/fixtures/package-load-hooks.mjs')).href;
/** Makes a package's first require() fail (startServerRecordingModules({ failPackageOnce })) */
const PACKAGE_LOAD_PRELOAD = pathToFileURL(path.join(PROJECT_ROOT, 'test/fixtures/package-load-preload.mjs')).href;

/** Packages only reading, writing or rendering Excel, PDF and DOCX files need */
export const HEAVY_PACKAGES = ['exceljs', 'pdf-lib', 'md-to-pdf', 'puppeteer', 'unpdf', '@opendocsg/pdf2md', 'pizzip'];

/** The npm package a module URL belongs to ('@scope/name' or 'name'), or undefined for Node's and the server's own modules */
export function packageOf(url) {
  const marker = '/node_modules/';
  const at = url.lastIndexOf(marker);
  if (at === -1) return undefined;
  const [first, second] = url.slice(at + marker.length).split('/');
  return first.startsWith('@') ? `${first}/${second}` : first;
}

function chromeExecutable(buildDir) {
  if (process.platform === 'win32') return path.join(buildDir, 'chrome-win64', 'chrome.exe');
  if (process.platform === 'darwin') {
    return path.join(buildDir, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
  }
  return path.join(buildDir, 'chrome-linux64', 'chrome');
}

/**
 * Puts two Chrome for Testing builds (empty stand-ins) in Desktop Commander's
 * Puppeteer cache. The server's Chrome warm-up picks the newer one and removes
 * the older one, and never downloads Chrome.
 */
function seedChromeCache() {
  const chromeDir = path.join(os.homedir(), '.claude-server-commander', 'puppeteer-cache', 'chrome');
  const [stale, current] = ['100.0.0.0', '101.0.0.0'].map((version) => path.join(chromeDir, `test-${version}`));
  for (const buildDir of [stale, current]) {
    const executable = chromeExecutable(buildDir);
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, '');
  }
}

/**
 * Starts the real server (dist/index.js) over MCP stdio, the way a client
 * does, with a preload that records every module it resolves (import and
 * require). Resolves once `initialize` is answered.
 *
 * With `holdPackage` (an npm package name), the server's imports of that
 * package don't resolve until release() is called: it stays "still loading".
 * With `failPackageOnce`, the server's first import or require() of that package fails.
 * While a package is held, keep other module loads out of the test: the
 * held import can hold up the server's other imports and requires.
 *
 * Returns:
 * - client: the connected MCP client
 * - startedAt: Date.now() at spawn
 * - initializedAt: Date.now() when the `initialize` answer arrived, before the
 *   client sent `notifications/initialized` (what the server does after that
 *   comes later)
 * - modules(): every module resolved so far, first resolution each: [{ at, url, parent }]
 * - logs(): what the server has logged so far (MCP log notifications), one string each
 * - release(): lets a held package load
 * - close()
 *
 * It writes to Desktop Commander's folder in the home, so it runs only in a test home.
 */
export async function startServerRecordingModules({ holdPackage, failPackageOnce } = {}) {
  if (!isTestHome()) {
    throw new Error('startServerRecordingModules writes to the home: run it through the test or repro runner');
  }
  // The Chrome warm-up after the handshake finds a (stand-in) Chrome and never downloads one
  seedChromeCache();
  const logFile = path.join(os.homedir(), `modules-${process.pid}-${Date.now()}.log`);
  const releaseFile = path.join(os.homedir(), `release-${process.pid}-${Date.now()}`);
  const failedMarker = path.join(os.homedir(), `failed-${process.pid}-${Date.now()}`);
  fs.writeFileSync(logFile, '');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      ...(holdPackage || failPackageOnce ? hookArgs(PACKAGE_LOAD_HOOKS) : []),
      ...(failPackageOnce ? ['--import', PACKAGE_LOAD_PRELOAD] : []),
      ...hookArgs(HOOKS), '--import', PRELOAD, SERVER, '--no-onboarding',
    ],
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      DC_TEST_MODULE_LOG: logFile,
      ...(holdPackage ? { DC_TEST_HOLD_PACKAGE: holdPackage, DC_TEST_HOLD_RELEASE: releaseFile } : {}),
      ...(failPackageOnce ? { DC_TEST_FAIL_PACKAGE_ONCE: failPackageOnce, DC_TEST_FAILED_MARKER: failedMarker } : {}),
    },
    stderr: 'pipe',
  });
  // The moment the initialize answer arrives, seen before the client acts on it
  let initializedAt;
  let onMessage;
  Object.defineProperty(transport, 'onmessage', {
    configurable: true,
    get: () => onMessage,
    set: (handler) => {
      onMessage = handler && ((message, extra) => {
        if (initializedAt === undefined && message?.result?.serverInfo) initializedAt = Date.now();
        return handler(message, extra);
      });
    },
  });
  const client = new Client({ name: 'startup-modules-test', version: '1.0.0' }, { capabilities: {} });
  const logLines = [];
  client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
    logLines.push(String(notification.params.data));
  });
  const startedAt = Date.now();
  await client.connect(transport, { timeout: 120_000 });

  const modules = () => {
    const seen = new Map();
    for (const line of fs.readFileSync(logFile, 'utf8').split('\n')) {
      const [at, url, parent] = line.split(' ');
      if (url && !seen.has(url)) seen.set(url, { at: Number(at), url, parent });
    }
    return [...seen.values()];
  };

  const release = () => fs.writeFileSync(releaseFile, '');

  const close = async () => {
    release();
    await closeClient(client);
    fs.rmSync(logFile, { force: true });
    fs.rmSync(releaseFile, { force: true });
    fs.rmSync(failedMarker, { force: true });
  };

  return { client, startedAt, initializedAt, modules, logs: () => [...logLines], release, close };
}
