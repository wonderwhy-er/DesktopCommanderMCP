import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

test('the review prompt defines measured uncovered ranges and keeps unknown coverage unchecked', () => {
  const prompt = fs.readFileSync(path.join(ROOT, '.github/review-prompt.md'), 'utf8');
  const sorting = prompt.split('## Sort each finding')[1].split('## Don\'t guess')[0];
  const definition = sorting.split('\n').find((line) => line.startsWith('- **not covered:**'));
  assert.ok(definition, 'Sort each finding must define its permitted not covered kind');
  assert.match(definition, /supplied measured (?:uncovered )?ranges/);
  assert.match(definition, /unknown.*not checked/i);
  assert.match(prompt, /Missing or unreadable test, coverage or guide inputs.*not checked/);
});

function checkUnreadableCall(input) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-review-budget-input-'));
  try {
    const state = path.join(folder, 'calls');
    const call = () => spawnSync(process.execPath, [path.join(ROOT, 'test/ci-review-budget.js'), state, '1'], {
      input,
      encoding: 'utf8',
    });
    const first = call();
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout), {});
    assert.equal(fs.readFileSync(state, 'utf8'), '1');
    const second = call();
    assert.equal(second.status, 0, second.stderr);
    const refusal = JSON.parse(second.stdout);
    assert.equal(refusal.decision, 'deny');
    assert.match(refusal.reason, /budget is used up \(1 tool calls\)/);
    assert.equal(fs.readFileSync(state, 'utf8'), '2');
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

test('the retained budget hook counts malformed stdin and refuses it after the limit', () => {
  checkUnreadableCall('{broken');
});

test('the retained budget hook counts empty stdin and refuses it after the limit', () => {
  checkUnreadableCall('');
});
