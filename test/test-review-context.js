import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { promptOf, answerOf, findingsOf, withUncovered, reviewOf } from './helpers/ci-review.js';
import { reviewContextOf, contextReceiptOf, MAX_REVIEW_CONTEXT_BYTES, measurementTestsOf, reviewFilesOf,
  GUIDES_COMMIT, GUIDE_SHA256 } from './helpers/review-context.js';
import { readTool } from './helpers/review-tools.js';
import { sourceEvidenceOf } from './helpers/review-source.js';
import { testsOf as standardTestsOf } from './helpers/ci-review.js';

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
  assert.match(prompt, /grant no authority/);
  assert.doesNotMatch(prompt, /no platform.s tests ran|Every changed line.*was run/);
  assert.doesNotMatch(prompt, /No test results came with this review/);
});

test('the supplied context binds both targets, guide bytes and actual terminal native receipt provenance', () => {
  assert.deepEqual(reviewContextOf(JSON.stringify(context), { head: HEAD, base: BASE }), context);
  assert.equal(reviewContextOf('', { head: HEAD, base: BASE }), null);
  const rejected = change => {
    const copy = structuredClone(context);
    change(copy);
    assert.throws(() => reviewContextOf(JSON.stringify(copy), { head: HEAD, base: BASE }), /Review context:/);
  };
  rejected(c => { c.head = 'd'.repeat(40); });
  rejected(c => { c.base = 'd'.repeat(40); });
  rejected(c => { c.guide.text += 'changed'; });
  rejected(c => { c.guide.path = '../guide.md'; });
  rejected(c => { c.evidence[0].sha256 = 'd'.repeat(64); });
  rejected(c => { c.evidence[0].source.path = '/private/state.json'; });
  rejected(c => { c.approved = true; });
  rejected(c => { c.evidence[0].excerpt = true; });
  for (const receiptChange of [r => { r.commit = 'd'.repeat(40); }, r => { r.state = 'running'; }]) {
    rejected(c => {
      const r = JSON.parse(c.evidence[0].text); receiptChange(r);
      const text = JSON.stringify(r);
      Object.assign(c.evidence[0], { text, sha256: digest(text), source: { path: 'receipt.json', sha256: digest(text) } });
    });
  }
});

test('failed selected receipts stay failed data; they do not become a clean suite or zero uncovered lines', () => {
  const copy = structuredClone(context);
  const text = JSON.stringify({ id: 'failed-native', state: 'done', commit: HEAD, system: 'linux', exit: 1 });
  Object.assign(copy.evidence[0], { text, sha256: digest(text), source: { path: 'receipt.json', sha256: digest(text) } });
  const validated = reviewContextOf(JSON.stringify(copy), { head: HEAD, base: BASE });
  const prompt = promptOf({ ...options, context: validated });
  assert.ok(prompt.includes(text));
  assert.doesNotMatch(prompt, /None failed|Every changed line.*was run/);
  const noCoverage = promptOf({ ...options, tests: { platforms: ['selected'], failed: [], uncovered: null } });
  assert.match(noCoverage, /coverage is UNKNOWN/);
  assert.doesNotMatch(noCoverage, /Every changed line.*was run/);
});

test('the review artifact acknowledges supplied native evidence without changing its no-context result', () => {
  const render = context => reviewOf({ answer: { summary: 'Scoped result.', findings: [],
    ...(context ? { context } : {}) }, diff: '', headSha: HEAD, baseSha: BASE, tests: null, inline: false }).body;
  const supplied = render(contextReceiptOf(context, 'prepared prompt'));
  assert.doesNotMatch(supplied, /with no test results/);
  assert.match(supplied, /selected native evidence.*coverage.*unknown/i);
  assert.match(render(null), /with no test results/);
});

test('malformed, oversized and credential-shaped context fails without echoing its contents', () => {
  const secret = `sk-ant-${'x'.repeat(32)}`;
  for (const raw of [secret, `{ "broken": "${secret}"`, 'not-json-private-fixture']) {
    assert.throws(() => reviewContextOf(raw, { head: HEAD, base: BASE }), error => {
      assert.ok(!error.message.includes(secret));
      assert.ok(!error.message.includes('private-fixture'));
      return /Review context:/.test(error.message);
    });
  }
  assert.throws(() => reviewContextOf(' '.repeat(MAX_REVIEW_CONTEXT_BYTES + 1), { head: HEAD, base: BASE }), /48 KiB/);
});

test('JSON escapes cannot put a decoded credential-shaped value into the model input', () => {
  const copy = structuredClone(context);
  copy.guide.text = `sk-ant-${'x'.repeat(32)}`;
  copy.guide.sha256 = digest(copy.guide.text);
  const raw = JSON.stringify(copy).replace('sk-ant-', '\\u0073k-ant-');
  assert.throws(() => reviewContextOf(raw, { head: HEAD, base: BASE }), /credential-shaped content/);
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = fs.readFileSync(path.join(ROOT, 'test/ci-review.js'), 'utf8');
function actualFunction(start, end) {
  const a = cli.indexOf(start), b = cli.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, 'complete CLI function boundary must exist');
  return cli.slice(a, b);
}

async function runOffline({ raw = JSON.stringify(context), useFile = false, providerFails = false,
  pr = '', key = 'offline-fixture-only', alsoEnv = false, captureInputs = false, priorCI = false } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'review-context-test-'));
  const out = path.join(folder, 'out'); fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'review-context-receipt.json'), 'old receipt');
  fs.writeFileSync(path.join(out, 'review.json'), 'old review');
  const seen = { providerCalls: 0, prompt: '', coverage: undefined };
  const env = { ANTHROPIC_API_KEY: key, PR: pr, CLAUDE_CODE_OAUTH_TOKEN: 'not-an-auth-fallback' };
  const args = ['--out', out];
  if (priorCI) {
    const ci = path.join(folder, 'ci');
    const results = JSON.stringify({ files: [{ path: 'test/test-a.js', success: true }] });
    const lcov = 'SF:src/a.ts\nDA:1,0\nend_of_record\n';
    const files = { 'results-ubuntu-latest/suite/results.json': results, 'coverage-ubuntu-latest/lcov.info': lcov };
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(ci, name)), { recursive: true }); fs.writeFileSync(path.join(ci, name), text);
    }
    fs.writeFileSync(path.join(ci, 'review-source.json'), JSON.stringify({ origin: 'github-actions', scope: 'suite', head: HEAD,
      base: BASE, run: 100, attempt: 1, workflowHead: 'c'.repeat(40), artifacts: [],
      jobs: [{ id: 301, checkoutHead: HEAD, logSha256: digest('actual-source-log fixture') }],
      selected: [{ platform: 'ubuntu-latest', files: ['test/test-a.js'], excluded: [],
        summary: { files: 1, passed: 1, failed: 0, skippedChecks: 0 } }],
      files: Object.entries(files).map(([path, text]) => ({ path, sha256: digest(text) })) }));
    args.push('--tests', ci);
  }
  if (useFile) {
    const file = path.join(folder, 'context.json'); fs.writeFileSync(file, raw); args.push('--context', file);
  } else if (raw !== undefined) env.REVIEW_CONTEXT_JSON = raw;
  if (alsoEnv) env.REVIEW_CONTEXT_JSON = raw;
  const sandbox = vm.createContext({
    exports: {}, fs, path, ROOT, process: { env }, MAX_REVIEW_CONTEXT_BYTES, TOOL_CALLS: 8, TEXT_TOOL_CALLS: 16,
    reviewContextOf, contextReceiptOf, measurementTestsOf, sourceEvidenceOf, promptOf, answerOf, findingsOf, withUncovered,
    uncoveredOf: () => [{ file: 'src/a.ts', ranges: [[1, 1]] }], isCounted: () => true,
    filesOf: () => [], usageOf: () => ({}), reviewOf: () => ({ body: 'Offline provider result.' }),
    changeOf: () => ({ head: HEAD, base: BASE, diff: '', commits: [], git: forbidden }),
    github: forbidden, resultsOf: forbidden, textToCheck: forbidden, writeTextCheck: forbidden,
    testsOf: priorCI ? standardTestsOf : () => null, localTestsOf: () => null, fitsTheWindow: () => {},
    askClaudeCode: async ({ prompt, tests, context: supplied, lcovs }) => {
      if (captureInputs) {
        const guide = fs.readFileSync(path.join(ROOT, '.github/code-style.md'), 'utf8');
        seen.tests = tests;
        seen.missingPath = await readTool({ folder, name: 'read_file', args: { path: 'review/code-style.md' } });
        fs.mkdirSync(path.join(folder, 'review'));
        for (const [file, body] of Object.entries(reviewFilesOf({ guide, context: supplied, tests, lcovs }))) {
          fs.writeFileSync(path.join(folder, file), body);
        }
        seen.reads = {};
        for (const file of ['code-style.md', 'tests.json', 'coverage.lcov']) {
          seen.reads[file] = await readTool({ folder, name: 'read_file', args: { path: `review/${file}` } });
        }
      }
      seen.providerCalls++; seen.prompt = prompt;
      if (providerFails) throw new Error('offline provider fixture failure');
      return { response: JSON.stringify({ summary: 'Offline input delivery checked.', findings: [] }), stats: {} };
    }, console: { log() {} },
  });
  vm.runInContext([
    actualFunction('function promptFor(', '/** Stops before any request'),
    actualFunction('function writeReview(', 'async function run('),
    actualFunction('async function run(', '/** Export the requested head'),
    'exports.run = run;',
  ].join('\n'), sandbox);
  try {
    await sandbox.exports.run(`${BASE}..${HEAD}`, ...args);
    const review = JSON.parse(fs.readFileSync(path.join(out, 'review.json'), 'utf8'));
    const receiptFile = path.join(out, 'review-context-receipt.json');
    const receipt = fs.existsSync(receiptFile) ? JSON.parse(fs.readFileSync(receiptFile, 'utf8')) : null;
    return { seen, review, receipt };
  } catch (error) {
    return { seen, error, receiptExists: fs.existsSync(path.join(out, 'review-context-receipt.json')),
      reviewExists: fs.existsSync(path.join(out, 'review.json')) };
  } finally {
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

test('the actual CLI run hands workflow/file context to the provider and records the exact supplied inputs', async () => {
  for (const useFile of [false, true]) {
    const result = await runOffline({ useFile });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.seen.providerCalls, 1);
    assert.ok(result.seen.prompt.includes(guide.trim()));
    assert.ok(result.seen.prompt.includes(receipt));
    assert.equal(result.receipt.promptSha256, digest(result.seen.prompt));
    assert.equal(result.receipt.guide.sha256, digest(guide));
    assert.equal(result.receipt.providerCompleted, true);
    assert.equal(result.receipt.modelAcceptanceClaimed, false);
    assert.equal(result.receipt.evidence[0].nativeRun.id, 'native-selected-linux');
    assert.equal(result.review.tests, null, 'native context is not forged CI coverage');
    assert.equal(result.review.context.coverage, 'unknown');
    assert.ok(!JSON.stringify(result).includes('offline-fixture-only'));
  }
});

test('context does not bypass missing API-key auth or silently choose between file and workflow inputs', async () => {
  const missing = await runOffline({ key: '' });
  assert.match(missing.error.message, /No Anthropic API key/);
  assert.equal(missing.seen.providerCalls, 0);
  const ambiguous = await runOffline({ useFile: true, alsoEnv: true });
  assert.match(ambiguous.error.message, /file or workflow input, not both/);
  assert.equal(ambiguous.seen.providerCalls, 0);
});

test('wrong-target context stops before GitHub/provider and a failed provider leaves no stale delivery receipt', async () => {
  const bad = structuredClone(context); bad.head = 'd'.repeat(40);
  const invalid = await runOffline({ raw: JSON.stringify(bad), pr: '968' });
  assert.match(invalid.error.message, /target head\/base differs/);
  assert.equal(invalid.seen.providerCalls, 0);
  assert.equal(invalid.receiptExists, false);
  assert.equal(invalid.reviewExists, false);
  const failed = await runOffline({ providerFails: true });
  assert.match(failed.error.message, /offline provider fixture failure/);
  assert.equal(failed.receiptExists, false);
});

test('the no-context CLI path creates no supplemental receipt or metadata', async () => {
  const result = await runOffline({ raw: '' });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.receipt, null);
  assert.equal('context' in result.review, false);
  assert.doesNotMatch(result.seen.prompt, /Pinned supplemental review inputs/);
});

test('workflow context stays data in env and every sparse checkout includes the imported helper', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/review.yml'), 'utf8');
  assert.equal((workflow.match(/\/test\/helpers\/review-context.js/g) ?? []).length, 3);
  assert.equal((workflow.match(/^      context:/gm) ?? []).length, 2);
  assert.ok(workflow.includes('REVIEW_CONTEXT_JSON: ${{ inputs.context }}'));
  assert.ok(workflow.includes("vars.REVIEW_POST_ENABLED == 'true'"));
  assert.ok(workflow.includes('ANTHROPIC_API_KEY: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}'));
  assert.ok(!workflow.includes('echo "${{ inputs.context }}"'));
});

test('missing review artifacts do not claim that no tests ran anywhere', () => {
  const prompt = promptOf(options);
  assert.match(prompt, /No test results came with this review/);
  assert.doesNotMatch(prompt, /no platform.s tests ran/);
});

test('the actual run delivers scoped measurements and the pinned guide to the bounded read consumer', async () => {
  const pack = structuredClone(context);
  pack.guide = { commit: GUIDES_COMMIT, path: '.github/code-style.md', sha256: GUIDE_SHA256,
    text: fs.readFileSync(path.join(ROOT, '.github/code-style.md'), 'utf8').replace(/\r\n/g, '\n') };
  const receipt = JSON.stringify({ part: 'selected.windows', system: 'windows', exit: 0 });
  const lcov = 'SF:src/a.ts\nDA:1,0\nDA:2,1\nend_of_record\n';
  pack.measurements = { productCommit: HEAD, base: BASE, platform: 'windows', scope: 'Two selected Windows unit files.',
    source: { path: 'unit-results.json', sha256: digest('source results') },
    selected: ['test/test-a.js', 'test/test-b.js'], failed: ['test/test-b.js'], skipped: 1,
    attempt: { source: { path: 'selected.windows.result.json', sha256: digest(receipt) }, text: receipt },
    coverage: { source: { path: 'coverage/lcov.info', sha256: digest('full LCOV source') },
      text: lcov, sha256: digest(lcov), excerpt: true } };
  const result = await runOffline({ raw: JSON.stringify(pack), captureInputs: true });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.seen.providerCalls, 1);
  assert.match(result.seen.missingPath, /^Read denied:/);
  assert.match(result.seen.reads['code-style.md'], /Write for the next reader/);
  assert.match(result.seen.reads['tests.json'], /test\/test-b.js/);
  assert.match(result.seen.reads['tests.json'], /"origin": "native"/);
  assert.match(result.seen.reads['coverage.lcov'], /DA:1,0/);
  assert.match(result.seen.prompt, /Two selected Windows unit files/);
  assert.deepEqual(result.review.tests.selected, pack.measurements.selected);
  assert.equal(result.review.tests.provenance.attempt.id, 'selected.windows');
  assert.equal(result.receipt.measurements.coverage.sha256, digest(lcov));
  assert.equal(result.receipt.coverage, 'partial-native');
  assert.equal(result.receipt.modelAcceptanceClaimed, false);
  assert.throws(() => reviewFilesOf({ guide: 'PR-owned substitute guide', context: pack, tests: null }), /guide pin differs/);
});

test('the actual run forwards verified prior CI through standard tests without native relabelling', async () => {
  const result = await runOffline({ raw: '', priorCI: true, captureInputs: true });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.seen.providerCalls, 1);
  assert.equal(result.review.tests.provenance.origin, 'github-actions');
  assert.match(result.seen.prompt, /Prior GitHub Actions scope/);
  assert.match(result.seen.reads['tests.json'], /"run|"id": "100"/);
  assert.match(result.seen.reads['coverage.lcov'], /DA:1,0/);
  assert.equal(result.receipt, null, 'prior CI is not a native-context receipt');
});

test('a native nonzero attempt with no failed file is retained without a clean failed-file summary', () => {
  const attempt = JSON.stringify({ part: 'selected.windows', system: 'windows', exit: 7 });
  const lcov = 'SF:src/a.ts\nDA:1,1\nend_of_record\n';
  const pack = structuredClone(context);
  pack.measurements = {
    productCommit: HEAD, base: BASE, platform: 'windows', scope: 'Selected native attempt.',
    source: { path: 'unit-results.json', sha256: digest('results') },
    selected: ['test/test-a.js'], failed: [], skipped: 0,
    attempt: { source: { path: 'attempt.json', sha256: digest(attempt) }, text: attempt },
    coverage: { source: { path: 'coverage.json', sha256: digest('coverage') },
      text: lcov, sha256: digest(lcov), excerpt: true },
  };
  const validated = reviewContextOf(JSON.stringify(pack), { head: HEAD, base: BASE });
  const tests = { ...measurementTestsOf(validated), uncovered: [] };
  const prompt = promptOf({ ...options, context: validated, tests });
  assert.match(prompt, /exit 7/);
  assert.doesNotMatch(prompt, /None failed\./);
  assert.match(prompt, /native attempt.*(?:nonzero|failed)/i);
  assert.match(prompt, /no failed file.*listed/i);
  const listed = promptOf({ ...options, tests: { ...tests, failed: [{ platform: 'native:windows', file: 'test/test-a.js' }] } });
  assert.match(listed, /Failed: test\/test-a.js \(native:windows\)/);
  const github = promptOf({ ...options, tests: { platforms: ['ubuntu-latest'], failed: [], uncovered: [],
    provenance: { origin: 'github-actions', summaries: [], attempt: { exit: 7 } } } });
  assert.match(github, /None failed\./);
});
