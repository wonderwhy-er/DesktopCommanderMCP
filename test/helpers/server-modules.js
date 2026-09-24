import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { isTestHome } from './test-env.js';
import { closeClient } from './close-client.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER = path.join(PROJECT_ROOT, 'dist/index.js');
const PRELOAD = pathToFileURL(path.join(PROJECT_ROOT, 'test/fixtures/record-modules-preload.mjs')).href;

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
 * the older one, which shows the warm-up has run, and never downloads Chrome.
 * Returns the older build's folder.
 */
function seedChromeCache() {
  const chromeDir = path.join(os.homedir(), '.claude-server-commander', 'puppeteer-cache', 'chrome');
  const [stale, current] = ['100.0.0.0', '101.0.0.0'].map((version) => path.join(chromeDir, `test-${version}`));
  for (const buildDir of [stale, current]) {
    const executable = chromeExecutable(buildDir);
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, '');
  }
  return stale;
}

/**
 * Starts the real server (dist/index.js) over MCP stdio, the way a client
 * does, with a preload that records every module it resolves (import and
 * require). Resolves once `initialize` is answered.
 *
 * Returns:
 * - client: the connected MCP client
 * - startedAt / initializedAt: Date.now() at spawn and once `initialize` was answered
 * - modules(): every module resolved so far, first resolution each: [{ at, url, parent }]
 * - waitForChromeWarmUp(timeoutMs): resolves true once the server's Chrome warm-up
 *   (run after the handshake) has finished, false if it hasn't within timeoutMs
 * - close()
 *
 * It writes to Desktop Commander's folder in the home, so it runs only in a test home.
 */
export async function startServerRecordingModules() {
  if (!isTestHome()) {
    throw new Error('startServerRecordingModules writes to the home: run it through the test or repro runner');
  }
  const staleChromeBuild = seedChromeCache();
  const logFile = path.join(os.homedir(), `modules-${process.pid}-${Date.now()}.log`);
  fs.writeFileSync(logFile, '');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', PRELOAD, SERVER, '--no-onboarding'],
    cwd: PROJECT_ROOT,
    env: { ...process.env, DC_TEST_MODULE_LOG: logFile },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'startup-modules-test', version: '1.0.0' }, { capabilities: {} });
  const startedAt = Date.now();
  await client.connect(transport, { timeout: 120_000 });
  const initializedAt = Date.now();

  const modules = () => {
    const seen = new Map();
    for (const line of fs.readFileSync(logFile, 'utf8').split('\n')) {
      const [at, url, parent] = line.split(' ');
      if (url && !seen.has(url)) seen.set(url, { at: Number(at), url, parent });
    }
    return [...seen.values()];
  };

  const waitForChromeWarmUp = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (fs.existsSync(staleChromeBuild)) {
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return true;
  };

  const close = async () => {
    await closeClient(client);
    fs.rmSync(logFile, { force: true });
  };

  return { client, startedAt, initializedAt, modules, waitForChromeWarmUp, close };
}
