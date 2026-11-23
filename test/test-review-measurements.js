import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import * as inputs from './helpers/review-context.js';
import { promptOf, uncoveredOf } from './helpers/ci-review.js';

const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40);
const digest = text => createHash('sha256').update(text).digest('hex');
const source = (path, text) => ({ path, sha256: digest(text) });
const guide = 'A pinned project guide.\n';
const receipt = JSON.stringify({ part: 'selected.windows', system: 'windows', exit: 0 });
const lcov = 'SF:src/a.ts\nDA:1,0\nDA:2,1\nend_of_record\n';
const context = {
  version: 1, head: HEAD, base: BASE,
  guide: { commit: 'c'.repeat(40), path: '.github/code-style.md', text: guide, sha256: digest(guide) },
  evidence: [{ kind: 'report', name: 'Selected result limits', source: source('report.md', 'Windows only.'),
    sha256: digest('Windows only.'), text: 'Windows only.' }],
  measurements: {
    productCommit: HEAD, base: BASE, platform: 'windows', scope: 'Selected unit files; coverage records for src/a.ts only.',
    source: source('unit-results.json', 'original result source'),
    selected: ['test/test-a.js', 'test/test-b.js'], failed: ['test/test-b.js'], skipped: 1,
    attempt: { source: source('selected.windows.result.json', receipt), text: receipt },
    coverage: { source: source('coverage/lcov.info', 'full source LCOV'), sha256: digest(lcov), text: lcov, excerpt: true },
  },
};
const validated = value => inputs.reviewContextOf(JSON.stringify(value), { head: HEAD, base: BASE });

test('verified native measurements become scoped structured tests with real uncovered lines', () => {
  const parsed = validated(context);
  const ran = inputs.measurementTestsOf(parsed);
  assert.deepEqual(ran.platforms, ['native:windows']);
  assert.deepEqual(ran.failed, [{ platform: 'native:windows', file: 'test/test-b.js' }]);
  assert.deepEqual(ran.selected, context.measurements.selected);
  assert.deepEqual(ran.lcovs, [lcov]);
  const diff = '+++ b/src/a.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n';
  const tests = { ...ran, uncovered: uncoveredOf({ diff, lcovs: ran.lcovs }) };
  assert.deepEqual(tests.uncovered, [{ file: 'src/a.ts', ranges: [[1, 1]] }]);
  const prompt = promptOf({ template: 'Review.', headSha: HEAD, baseSha: BASE, files: ['src/a.ts'],
    title: '', description: '', calls: 8, tests, context: parsed });
  assert.match(prompt, /Selected unit files/);
  assert.match(prompt, /native:windows/);
  assert.match(prompt, /test\/test-b.js/);
  assert.match(prompt, /src\/a.ts: 1/);
  assert.match(prompt, /outside the supplied coverage records.*UNKNOWN/);
});

test('measurement target, attempt hash, manifest and missing coverage fail before consumption', () => {
  for (const mutate of [
    c => { c.measurements.productCommit = 'd'.repeat(40); },
    c => { c.measurements.base = 'd'.repeat(40); },
    c => { c.measurements.attempt.text += 'changed'; },
    c => { c.measurements.attempt.source.path = '../receipt.json'; },
    c => { c.measurements.selected.push(c.measurements.selected[0]); },
    c => { c.measurements.failed = ['test/absent.js']; },
    c => { delete c.measurements.coverage; },
    c => { c.measurements.coverage.text = ''; },
    c => { c.measurements.coverage.text = 'SF:../escape.ts\nDA:1,1\nend_of_record\n';
      c.measurements.coverage.sha256 = digest(c.measurements.coverage.text); },
  ]) {
    const changed = structuredClone(context); mutate(changed);
    assert.throws(() => validated(changed), /Review context:/);
  }
});

test('legacy native text evidence remains separate when no measured inputs were supplied', () => {
  const legacy = structuredClone(context); delete legacy.measurements;
  const parsed = validated(legacy);
  assert.equal(inputs.measurementTestsOf(parsed), null);
  assert.equal(inputs.contextReceiptOf(parsed, 'prompt').coverage, 'unknown');
});
