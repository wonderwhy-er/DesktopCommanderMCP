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

const MERGE = 'f'.repeat(40), TEST_BASE = '9'.repeat(40), TREE = '8'.repeat(40);
const defaultParts = ['suite', 'repro', 'integration', 'docker', 'repro-rebuilds-dist'];
const producerText = fs.readFileSync(path.join(ROOT, 'test/run-ci.js'), 'utf8').replace(/\r\n/g, '\n');
const producerBlob = createHash('sha1').update(`blob ${Buffer.byteLength(producerText)}\0${producerText}`).digest('hex');

function defaultFixture({ wrongTree = false, falseParent = false, testsValue = '', missingPart = false } = {}) {
  const input = structuredClone(manifest); input.scope = 'ci-default';
  input.artifacts = [...defaultParts.filter(part => !missingPart || part !== 'integration').map(part => ({
    ...manifest.artifacts[0], file: { path: `${part}/results.json`, sha256: digest(results) },
  })), manifest.artifacts[1]];
  const text = log.replace(HEAD, MERGE).replace('TESTS: test', `TESTS: ${testsValue}`)
    + '2026-01-01T00:00:04Z [command]git checkout --force refs/remotes/pull/969/merge\n'
    + '2026-01-01T00:00:05Z ##[group]Run npm run test:coverage\n'
    + ['suite', 'repro', 'integration', 'docker', 'repro, rebuilds dist/ (not covered)',
      'coverage build again', 'copied scripts mapped again'].map(name => `########## ${name} ##########\n`).join('');
  const github = async (method, url, body, format) => {
    if (url.endsWith('/attempts/1')) return { id: 100, run_attempt: 1, status: 'completed', head_sha: HEAD,
      event: 'pull_request', pull_requests: [{ number: 969 }] };
    if (url.includes('/git/commits/')) {
      const sha = url.split('/').at(-1);
      if (sha === MERGE) return { sha, tree: { sha: wrongTree ? HARNESS : TREE },
        parents: [{ sha: falseParent ? HARNESS : TEST_BASE }, { sha: HEAD }] };
      if (sha === HEAD) return { sha, tree: { sha: TREE }, parents: [{ sha: TEST_BASE }] };
      if (sha === BASE) return { sha, tree: { sha: '7'.repeat(40) }, parents: [{ sha: TEST_BASE }] };
    }
    if (url.includes('/contents/test/run-ci.js')) return { sha: producerBlob };
    if (url.endsWith('/jobs/301/logs')) return text;
    const answer = await apiFixture()(method, url, body, format);
    if (answer.artifacts) answer.artifacts.forEach(a => { a.workflow_run.head_sha = HEAD; });
    return answer;
  };
  return { input, github };
}

function apiFixture({ product = HEAD, attempt = 1, mixedArtifact = false, scope = 'test', testsFrom = '' } = {}) {
  return async (_method, url, _body, format) => {
    if (url.endsWith('/attempts/1')) return { id: 100, run_attempt: attempt, status: 'completed',
      conclusion: 'success', head_sha: HARNESS };
    if (url.includes('/attempts/1/jobs')) return { total_count: 1, jobs: [job] };
    if (url.includes('/artifacts?')) return { total_count: 2, artifacts: manifest.artifacts.map(a => ({ ...a,
      expired: false, created_at: '2026-01-01T00:09:00Z', workflow_run: { id: mixedArtifact ? 99 : 100,
        head_sha: HARNESS } })) };
    if (url.endsWith('/jobs/301/logs')) {
      assert.equal(format, 'text');
      return log.replace(HEAD, product).replace('TESTS: test', `TESTS: ${scope}`)
        + (testsFrom ? `2026-01-01T00:00:04Z   TESTS_FROM: ${testsFrom}\n` : '');
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
  assert.ok(workflow.includes('/test/run-ci.js'), 'default-scope verification has the trusted producer in sparse checkout');
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

test('default PR CI accepts API-verified same-tree merges and the trusted producer manifest', async () => {
  const { verifyPriorRun } = await import('./helpers/review-source.js');
  const fixture = defaultFixture();
  const checked = await verifyPriorRun({ raw: JSON.stringify(fixture.input), repo: 'owner/repo',
    head: HEAD, base: BASE, github: fixture.github });
  assert.equal(checked.scope, 'ci-default');
  assert.equal(checked.jobs[0].checkoutHead, MERGE, 'tested merge identity is retained');
  assert.equal(checked.jobs[0].sourceIdentity.requestedHead, HEAD);
  assert.equal(checked.jobs[0].producer.blob, producerBlob);
  assert.deepEqual(checked.jobs[0].producer.parts.sort(), [...defaultParts].sort());
  assert.equal(checked.artifacts.filter(a => a.name.startsWith('results-')).length, 5);
});

test('default CI rejects wrong trees, false merge parents, false TESTS values and mixed part scopes', async () => {
  const { verifyPriorRun } = await import('./helpers/review-source.js');
  for (const options of [{ wrongTree: true }, { falseParent: true }, { testsValue: 'test' }, { missingPart: true }]) {
    const fixture = defaultFixture(options);
    await assert.rejects(verifyPriorRun({ raw: JSON.stringify(fixture.input), repo: 'owner/repo',
      head: HEAD, base: BASE, github: fixture.github }), /Review source:/);
  }
});

test('logged files and changed selectors use the trusted producer without silently changing their values', async () => {
  const { verifyPriorRun } = await import('./helpers/review-source.js');
  for (const selector of ['test', 'files:test-one.js', 'changed:old..new']) {
    const fixture = defaultFixture({ testsValue: selector }); fixture.input.scope = selector;
    if (selector === 'test' || selector.startsWith('files:')) {
      fixture.input.artifacts = fixture.input.artifacts.filter(a => a.name.startsWith('coverage-') ||
        a.file.path === 'suite/results.json');
    }
    const checked = await verifyPriorRun({ raw: JSON.stringify(fixture.input), repo: 'owner/repo',
      head: HEAD, base: BASE, github: fixture.github });
    assert.equal(checked.jobs[0].producer.tests, selector);
    assert.equal(checked.scope, selector);
    assert.deepEqual(checked.jobs[0].producer.parts.sort(), selector.startsWith('changed:')
      ? [...defaultParts].sort() : ['suite']);
  }
});

test('legacy suite mode also refuses a nonempty unproved tests_from overlay', async () => {
  const { verifyPriorRun } = await import('./helpers/review-source.js');
  await assert.rejects(verifyPriorRun({ raw: JSON.stringify(manifest), repo: 'owner/repo', head: HEAD, base: BASE,
    github: apiFixture({ testsFrom: HARNESS }) }), /tests_from overlay/);
});
