import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { promptOf } from './helpers/ci-review.js';

// These input tests must never reach Git, gh, a provider, or even a local network service.
const require = createRequire(import.meta.url);
const forbidden = () => { throw new Error('Offline input test forbids process/network access'); };
for (const [module, names] of [
  ['node:child_process', ['spawn', 'spawnSync', 'exec', 'execFile', 'execFileSync']],
  ['node:net', ['connect', 'createConnection', 'createServer']],
  ['node:http', ['request', 'get', 'createServer']],
  ['node:https', ['request', 'get']],
  ['node:tls', ['connect']],
]) for (const name of names) require(module)[name] = forbidden;
globalThis.fetch = forbidden;

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const digest = text => createHash('sha256').update(text).digest('hex');
const guide = '1. Keep helpers focused.\n2. Preserve launcher lifetime.\n';
const receipt = JSON.stringify({ id: 'native-selected-linux', state: 'done', commit: HEAD, system: 'linux', exit: 0 });
const context = {
  version: 1, head: HEAD, base: BASE,
  guide: { commit: 'c'.repeat(40), path: '.github/code-style.md', sha256: digest(guide), text: guide },
  evidence: [{ kind: 'native-receipt', name: 'Selected native checks',
    source: { path: 'test-runs/queue/parts/native-selected-linux.json', sha256: digest(receipt) },
    sha256: digest(receipt), text: receipt }],
};
const options = { template: 'Review the code.', headSha: HEAD, baseSha: BASE, files: ['src/a.ts'],
  title: 'A change', description: '', calls: 8, diff: '', tests: null };

test('the model prompt receives the pinned guide and actual selected native receipt without inventing coverage', () => {
  const prompt = promptOf({ ...options, context });
  assert.ok(prompt.includes(guide.trim()), 'the supplied code guide must reach the model prompt');
  assert.ok(prompt.includes(receipt), 'the native receipt must reach the model prompt');
  assert.match(prompt, /coverage.*unknown/i);
  assert.doesNotMatch(prompt, /no platform.s tests ran|Every changed line.*was run/);
});

test('missing review artifacts do not claim that no tests ran anywhere', () => {
  const prompt = promptOf(options);
  assert.match(prompt, /No test results came with this review/);
  assert.doesNotMatch(prompt, /no platform.s tests ran/);
});
