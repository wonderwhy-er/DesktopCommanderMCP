import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { testsOf } from './helpers/ci-review.js';
import { githubApi } from './helpers/github-api.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40), HARNESS = 'c'.repeat(40);
const digest = text => createHash('sha256').update(text).digest('hex');
const results = JSON.stringify({ summary: { files: 1, passed: 1, failed: 0, skippedChecks: 1 },
  files: [{ path: 'test/test-one.js', success: true, skipped: ['one conditional check'] }], excluded: [] });
const lcov = 'SF:src/one.ts\nDA:1,0\nDA:2,1\nend_of_record\n';
const manifest = { version: 1, run: 100, attempt: 1, scope: 'suite', artifacts: [
  { id: 201, name: 'results-ubuntu-latest', digest: `sha256:${'d'.repeat(64)}`,
    file: { path: 'suite/results.json', sha256: digest(results) } },
  { id: 202, name: 'coverage-ubuntu-latest', digest: `sha256:${'e'.repeat(64)}`,
    file: { path: 'lcov.info', sha256: digest(lcov) } },
] };
const job = { id: 301, run_id: 100, run_attempt: 1, name: 'unit (ubuntu-latest)', status: 'completed',
  conclusion: 'success', started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:10:00Z' };
const log = `2026-01-01T00:00:01Z [command]/usr/bin/git log -1 --format=%H\n2026-01-01T00:00:02Z ${HEAD}\n`
  + '2026-01-01T00:00:03Z   TESTS: test\n';

function apiFixture({ product = HEAD, attempt = 1, mixedArtifact = false, scope = 'test' } = {}) {
  return async (_method, url, _body, format) => {
    if (url.endsWith('/attempts/1')) return { id: 100, run_attempt: attempt, status: 'completed',
      conclusion: 'success', head_sha: HARNESS };
    if (url.includes('/attempts/1/jobs')) return { total_count: 1, jobs: [job] };
    if (url.includes('/artifacts?')) return { total_count: 2, artifacts: manifest.artifacts.map(a => ({ ...a,
      expired: false, created_at: '2026-01-01T00:09:00Z', workflow_run: { id: mixedArtifact ? 99 : 100,
        head_sha: HARNESS } })) };
    if (url.endsWith('/jobs/301/logs')) {
      assert.equal(format, 'text');
      return log.replace(HEAD, product).replace('TESTS: test', `TESTS: ${scope}`);
    }
    throw new Error(`Unexpected offline API request: ${url}`);
  };
}

test('the prior-run input is explicitly wired before the existing provider step', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/review.yml'), 'utf8');
  assert.ok(workflow.includes('SOURCE_RUN_JSON: ${{ inputs.source_run }}'));
  assert.ok(workflow.includes('artifact-ids: ${{ steps.source.outputs.artifacts }}'));
  assert.ok(workflow.includes('run-id: ${{ steps.source.outputs.run }}'));
  assert.ok(workflow.includes('node test/ci-review.js source-stage'));
});

test('prior CI checks product checkout separately from harness and retains standard suite/LCOV data', async t => {
  const { verifyPriorRun, stagePriorRun, sourceEvidenceOf } = await import('./helpers/review-source.js');
  const checked = await verifyPriorRun({ raw: JSON.stringify(manifest), repo: 'owner/repo', head: HEAD, base: BASE,
    github: apiFixture() });
  assert.equal(checked.head, HEAD); assert.equal(checked.workflowHead, HARNESS);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'review-source-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const downloaded = path.join(folder, 'downloaded'), out = path.join(folder, 'ci');
  for (const a of manifest.artifacts) {
    const file = path.join(downloaded, a.name, a.file.path); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, a.name.startsWith('results-') ? results : lcov);
  }
  // Auxiliary output from a unit's nested invocation is not a requested repro suite.
  const auxiliary = path.join(downloaded, 'results-ubuntu-latest/repro/results.json');
  fs.mkdirSync(path.dirname(auxiliary), { recursive: true }); fs.writeFileSync(auxiliary, '{"files":[]}');
  stagePriorRun({ checked, downloaded, out });
  const ran = testsOf(out), evidence = sourceEvidenceOf(out, { head: HEAD, base: BASE });
  assert.deepEqual(ran.platforms, ['ubuntu-latest']); assert.deepEqual(ran.failed, []);
  assert.deepEqual(ran.lcovs, [lcov]);
  assert.equal(evidence.provenance.origin, 'github-actions');
  assert.deepEqual(evidence.selected, [{ platform: 'ubuntu-latest', files: ['test/test-one.js'] }]);
  assert.equal(fs.existsSync(path.join(out, 'results-ubuntu-latest/repro')), false);
  fs.appendFileSync(path.join(out, 'coverage-ubuntu-latest/lcov.info'), 'changed');
  assert.throws(() => sourceEvidenceOf(out, { head: HEAD, base: BASE }), /Review source:/);
});

test('wrong product, attempt, mixed artifacts and selection refuse prior CI before provider work', async () => {
  const { verifyPriorRun } = await import('./helpers/review-source.js');
  for (const options of [{ product: HARNESS }, { attempt: 2 }, { mixedArtifact: true }, { scope: 'repro' }]) {
    await assert.rejects(verifyPriorRun({ raw: JSON.stringify(manifest), repo: 'owner/repo', head: HEAD, base: BASE,
      github: apiFixture(options) }), /Review source:/);
  }
});

test('the existing REST client retains JSON defaults and reads raw job logs only when selected', async t => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ id: 100 }), text: async () => log });
  const github = githubApi({ api: 'https://offline.invalid', token: 'synthetic-only' });
  assert.deepEqual(await github('GET', '/run'), { id: 100 });
  assert.equal(await github('GET', '/logs', null, 'text'), log);
});
