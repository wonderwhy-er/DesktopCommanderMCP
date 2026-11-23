import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { findingsOf, promptOf, reviewOf } from './helpers/ci-review.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const diff = 'diff --git a/source.ts b/source.ts\n+++ b/source.ts\n@@ -0,0 +1,3 @@\n+one\n+two\n+three\n';

test('the actual review prompt asks for bug and never the retired label', () => {
  const template = fs.readFileSync(new URL('../.github/review-prompt.md', import.meta.url), 'utf8');
  const prompt = promptOf({ template, headSha: HEAD, baseSha: BASE, files: ['source.ts'],
    title: 'A change', description: '', calls: 4, diff });
  assert.doesNotMatch(prompt, /real bugs?/i);
  assert.match(prompt, /\*\*bug:/);
  assert.match(prompt, /"kind": "bug"/);
});

test('current bug input retains its severity and Bug inline label', () => {
  const answer = { summary: 'One finding.', findings: [
    { kind: 'bug', file: 'source.ts', line: 1, text: 'A concrete failure.' },
  ] };
  assert.equal(findingsOf(answer, diff)[0].kind, 'bug');
  const review = reviewOf({ answer, diff, headSha: HEAD, baseSha: BASE });
  assert.match(review.body, /1 bug\. One finding\./);
  assert.match(review.body, /\| bug \| `source.ts:1` \|/);
  assert.equal(review.comments[0].body, '**Bug:** A concrete failure.');
});

test('legacy bug input keeps bug rank while new rendered output uses the current word', () => {
  // Old model envelopes stay readable; their saved bytes are not rewritten.
  const answer = { summary: 'Three findings.', findings: [
    { kind: 'nitpick', file: 'source.ts', line: 3, text: 'A style detail.' },
    { kind: ' Real BUG ', file: 'source.ts', line: 1, text: 'An older captured failure.' },
    { kind: 'bug', file: 'source.ts', line: 2, text: 'A current failure.' },
  ] };
  assert.deepEqual(findingsOf(answer, diff).map(({ kind }) => kind), ['nitpick', 'bug', 'bug']);
  const review = reviewOf({ answer, diff, headSha: HEAD, baseSha: BASE });
  assert.doesNotMatch(review.body, /real bugs?/i);
  assert.match(review.body, /2 bugs, 1 nitpick/);
  assert.ok(review.body.indexOf('source.ts:1') < review.body.indexOf('source.ts:2'));
  assert.ok(review.body.indexOf('source.ts:2') < review.body.indexOf('source.ts:3'));
  assert.deepEqual(review.comments.map(({ body }) => body.split(':')[0]), ['**Nitpick', '**Bug', '**Bug']);
  assert.equal(answer.findings[1].kind, ' Real BUG ', 'rendering does not rewrite the legacy input');
});
