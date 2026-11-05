/** Each publication check has its own files and trusted API fixture. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function publicationFixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-comment-proof-')));
  const results = path.join(dir, 'results-ubuntu-latest');
  const coverage = path.join(dir, 'coverage-ubuntu-latest');
  fs.mkdirSync(path.join(results, 'suite'), { recursive: true });
  fs.mkdirSync(coverage);
  const resultFile = path.join(results, 'suite/results.json');
  const summaryFile = path.join(coverage, 'coverage-summary.json');
  fs.writeFileSync(
    resultFile,
    JSON.stringify({ suite: 'suite', files: [{ path: 'test/test-example.js', success: true, skipped: [] }] })
  );
  const metric = { covered: 10, total: 10, pct: 100 };
  fs.writeFileSync(summaryFile, JSON.stringify({ total: { lines: metric, branches: metric, functions: metric } }));
  const expected = { product: 'a'.repeat(40), tests: 'b'.repeat(40), harness: 'c'.repeat(40), run: '1', attempt: '1' };
  const original = {
    id: 1,
    name: 'unit (ubuntu-latest)',
    run_id: 1,
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-11-01T10:00:00Z',
    completed_at: '2026-11-01T10:05:00Z',
    runner_id: 100,
    runner_name: 'runner'
  };
  const jobs = [original, { ...original, id: 3, run_attempt: 3 }];
  const artifacts = ['results-ubuntu-latest', 'coverage-ubuntu-latest'].map((name, id) => ({
    name,
    id,
    expired: false,
    created_at: '2026-11-01T10:04:00Z',
    workflow_run: { id: 1, head_sha: expected.harness }
  }));
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(request.url.includes('/jobs') ? { jobs } : { artifacts }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const render = () =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, 'test/ci-comment.js'), dir], {
        env: {
          ...process.env,
          GH_TOKEN: 'fixture',
          PR: '',
          RUN_ID: '1',
          HEAD_SHA: expected.product,
          TESTS_FROM: expected.tests,
          HARNESS_SHA: expected.harness,
          REQUIRE_EXECUTION: 'true',
          GITHUB_RUN_ATTEMPT: '3',
          GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`
        }
      });
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) => {
        try {
          assert.equal(code, 0, stderr);
          resolve(stdout);
        } catch (error) {
          reject(error);
        }
      });
    });
  const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const receipt = {
    ...expected,
    phase: 'complete',
    exit: 0,
    outputs: [
      { file: 'test-results/suite/results.json', sha256: hash(resultFile) },
      { file: 'coverage/coverage-summary.json', sha256: hash(summaryFile) }
    ]
  };
  const writeReceipt = (changes = {}) =>
    fs.writeFileSync(path.join(results, 'execution.json'), JSON.stringify({ ...receipt, ...changes }));
  return {
    jobs,
    resultFile,
    render,
    writeReceipt,
    cleanup: async () => {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

const cases = [
  ['missing execution evidence', () => {}, /execution provenance/],
  ['matching retained producer on post-only retry', (fixture) => fixture.writeReceipt(), /✅ 1 of 1 files passed/],
  [
    'stale product identity',
    (fixture) => fixture.writeReceipt({ product: 'd'.repeat(40) }),
    /Execution identity mismatch: product/
  ],
  [
    'stale harness identity',
    (fixture) => fixture.writeReceipt({ harness: 'd'.repeat(40) }),
    /Execution identity mismatch: harness/
  ],
  [
    'changed result bytes',
    (fixture) => {
      fixture.writeReceipt();
      fs.appendFileSync(fixture.resultFile, ' ');
    },
    /Missing or changed execution output/
  ],
  [
    'latest failed producer',
    (fixture) => {
      fixture.writeReceipt();
      fixture.jobs[1] = {
        ...fixture.jobs[1],
        conclusion: 'failure',
        started_at: '2026-11-01T11:00:00Z',
        completed_at: '2026-11-01T11:05:00Z'
      };
    },
    /Latest producer replaced/
  ]
];
for (const [name, prepare, expected] of cases)
  test(`publication handles ${name}`, async () => {
    const fixture = await publicationFixture();
    try {
      prepare(fixture);
      assert.match(await fixture.render(), expected);
    } finally {
      await fixture.cleanup();
    }
  });
