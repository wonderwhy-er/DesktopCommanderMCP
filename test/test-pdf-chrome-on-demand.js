/**
 * Regression for #797: an ordinary MCP handshake must not initiate
 * Chrome acquisition. Rendering still resolves Chrome on demand and
 * shares an in-flight acquisition promise.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const index = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');
const pdf = readFileSync(fileURLToPath(new URL('../src/tools/pdf/markdown.ts', import.meta.url)), 'utf8');

assert.doesNotMatch(index, /ensureChromeAvailable\s*\(/,
  'MCP initialization must not initiate a Chrome download');
assert.match(pdf, /const chromePath = await getChromePath\(\)/,
  'write_pdf must continue to acquire Chrome only when rendering');
assert.match(pdf, /if \(chromeCheckPromise\) \{/,
  'concurrent on-demand renders must share Chrome acquisition');
console.log('PDF Chrome acquisition remains on demand after MCP startup.');
