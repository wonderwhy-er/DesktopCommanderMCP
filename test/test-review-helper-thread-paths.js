import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { testsOf } from './helpers/ci-review.js';

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
