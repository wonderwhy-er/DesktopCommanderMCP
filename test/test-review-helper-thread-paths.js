import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { answerOf, findingsOf, reviewOf, testsOf, textAnswerOf, textCheckOf, textPromptOf, withUncovered } from './helpers/ci-review.js';

await test('a malformed results part leaves the other parts available to the review', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-review-results-'));
  try {
    const parts = path.join(folder, 'test-results');
    fs.mkdirSync(path.join(parts, 'suite'), { recursive: true });
    fs.mkdirSync(path.join(parts, 'repro'), { recursive: true });
    fs.writeFileSync(path.join(parts, 'suite', 'results.json'), JSON.stringify({
      files: [{ path: 'test/test-example.js', success: false }],
    }));
    // An interrupted report must not hide a completed part's failure.
    fs.writeFileSync(path.join(parts, 'repro', 'results.json'), '{"files":');
    assert.deepStrictEqual(testsOf(folder), {
      platforms: ['this machine'],
      failed: [{ platform: 'this machine', file: 'test/test-example.js' }],
      lcovs: [],
    });
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

const promptInput = {
  template: 'Check claims.', headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
  file: 'claims.md', text: 'Claim.', files: ['src/a.ts'], calls: 8,
};

const locatedFinding = { kind: 'bug', file: 'src/a.ts', line: 1, text: 'Located bug.' };
for (const [name, findings] of [
  ['missing file', [{ kind: 'bug', text: 'Unlocated bug.' }]],
  ['blank file', [{ kind: 'bug', file: '  ', text: 'Blank-location bug.' }]],
  ['normalized empty file', [{ kind: 'bug', file: 'pr/', text: 'Empty normalized location.' }]],
  ['missing finding', [undefined]],
  ['mixed located and unlocated findings', [locatedFinding, { kind: 'bug', text: 'Unlocated bug.' }]],
]) {
  test(`review rejects ${name} instead of dropping a finding or reporting clean`, () => {
    const answer = { summary: 'Checked.', findings };
    assert.throws(() => findingsOf(answer, ''), /finding.*file|file.*finding/i);
    assert.throws(() => reviewOf({ answer, diff: '', headSha: 'a', baseSha: 'b', tests: null }),
      /finding.*file|file.*finding/i);
  });
}

test('located review findings and shared text-check rows remain accepted', () => {
  const answer = { summary: 'Checked.', findings: [locatedFinding] };
  assert.deepEqual(findingsOf(answer, ''), [locatedFinding]);
  assert.match(reviewOf({ answer, diff: '', headSha: 'a', baseSha: 'b', tests: null }).body, /1 bug/);
  const textAnswer = { summary: 'Text.', findings: [{ kind: 'wrong claim', line: 1, text: 'A wrong claim.' }],
    checked: [] };
  assert.deepEqual(answerOf(JSON.stringify(textAnswer)), textAnswer);
  assert.match(textCheckOf({ answer: textAnswerOf(JSON.stringify(textAnswer)), file: 'claims.md', headSha: 'a' }),
    /claims\.md:1/);
});

test('oversized text checks fail rather than silently omitting claims', () => {
  assert.throws(() => textPromptOf({ ...promptInput, text: 'x'.repeat(50001) }), /50,000|50000/);
  assert.ok(textPromptOf({ ...promptInput, text: 'x'.repeat(50000) }).includes('1: ' + 'x'.repeat(50000)));
  assert.ok(textPromptOf({ ...promptInput, text: 'first\r\nsecond\r\n' }).includes('1: first\n2: second'));
});

test('cut results identify omitted characters and leave unseen claims not checked', () => {
  const prompt = textPromptOf({ ...promptInput, results: [{ name: 'result.txt', text: 'r'.repeat(40003) }] });
  assert.match(prompt, /truncated: 3 characters not shown/);
  assert.match(prompt, /unseen.*not checked/i);
  const short = textPromptOf({ ...promptInput, results: [{ name: 'result.txt', text: 'intact' }] });
  assert.ok(short.includes('intact'));
  assert.doesNotMatch(short, /truncated:/);
});

for (const origin of ['github-actions', 'native']) {
  test(`text checks retain ${origin} provenance and failures without coverage questions`, () => {
    const tests = {
      platforms: ['windows'], failed: [{ platform: 'windows', file: 'test/failed.js' }],
      uncovered: [{ file: 'src/a.ts', ranges: [[77, 79]] }],
      provenance: { origin, scope: 'selected files only', attempt: { id: '123', number: 1, exit: 1 },
        productCommit: 'a'.repeat(40), workflowHead: 'b'.repeat(40), jobs: [],
        summaries: [{ platform: 'windows', part: 'suite',
          summary: { files: 2, passed: 1, failed: 1, skippedChecks: 0 } }] },
    };
    const prompt = textPromptOf({ ...promptInput, tests });
    assert.match(prompt, /They ran on windows\. Failed: test\/failed.js/);
    assert.match(prompt, /123/);
    assert.match(prompt, /review\/tests.json/);
    assert.match(prompt, /selected files only/);
    if (origin === 'github-actions') assert.match(prompt, /2 selected files; 1 passed, 1 failed/);
    assert.doesNotMatch(prompt, /src\/a.ts: 77-79|Report each range above|Is each new or changed behaviour/);
  });
}

test('only coverage dispositions discharge a measured uncovered range', () => {
  const uncovered = [{ file: 'src/a.ts', ranges: [[4, 6]] }];
  for (const kind of ['bug', 'nitpick', 'not checked', 'unsorted']) {
    const findings = [{ kind, file: 'src/a.ts', line: 5, text: 'A finding.' }];
    assert.equal(withUncovered(findings, uncovered).length, 2, kind);
  }
  for (const kind of ['not covered', 'handled elsewhere']) {
    const findings = [{ kind, file: 'src/a.ts', line: 5, text: 'Coverage disposition.' }];
    assert.deepEqual(withUncovered(findings, uncovered), findings);
    assert.equal(withUncovered([{ ...findings[0], line: 7 }], uncovered).length, 2);
    assert.equal(withUncovered([{ ...findings[0], file: 'other.ts' }], uncovered).length, 2);
  }
});
