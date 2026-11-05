import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ciReview, fakeGitHub, git } from './test-ci-review.js';
import { reviewCliFixture } from './helpers/review-api-checks.js';
import { GUIDES_COMMIT } from './helpers/review-context.js';

const digest = text => createHash('sha256').update(text).digest('hex');

function nativeContext(head, base) {
  const guide = fs.readFileSync(new URL('../.github/code-style.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const receipt = JSON.stringify({ id: 'selected-linux', state: 'done', system: 'linux', commit: head, exit: 0 });
  return { version: 1, head, base,
    guide: { commit: GUIDES_COMMIT, path: '.github/code-style.md', sha256: digest(guide), text: guide },
    evidence: [{ kind: 'native-receipt', name: 'Selected Linux check',
      source: { path: 'receipts/selected-linux.json', sha256: digest(receipt) },
      sha256: digest(receipt), text: receipt }] };
}

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-post-context-'));
  let github;
  t.after(async () => {
    if (github) { github.server.closeAllConnections(); await new Promise(resolve => github.server.close(resolve)); }
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.name', 'Fixture author']);
  git(repo, ['config', 'user.email', 'fixture@example.invalid']);
  const commit = text => {
    fs.writeFileSync(path.join(repo, 'src/a.ts'), text); git(repo, ['add', '.']);
    git(repo, ['commit', '-qm', 'fixture']); return git(repo, ['rev-parse', 'HEAD']);
  };
  const base = commit('export const one = 1;\nexport const two = 1;\n');
  const head = commit('export const one = 1;\nexport const two = 2;\n');
  github = await fakeGitHub({ pull: { head: { sha: head }, base: { sha: base } } });
  const cli = reviewCliFixture({ dir, source: 'src/a.ts', head });
  fs.writeFileSync(cli.state, JSON.stringify({ mode: 'clean' }));
  const context = nativeContext(head, base);
  const contextFile = path.join(dir, 'context.json'); fs.writeFileSync(contextFile, JSON.stringify(context));
  const out = path.join(dir, 'out');
  const env = { GITHUB_API_URL: github.url, PR: '7' };
  return { dir, repo, base, head, github, cli, context, contextFile, out, env };
}

async function runContext(f) {
  const args = ['run', `${f.base}..${f.head}`, '--repo', f.repo, '--out', f.out, '--context', f.contextFile];
  const run = await ciReview(args,
    { ...f.env, ANTHROPIC_API_KEY: 'local-test-api-key', REVIEW_CLAUDE_CLI: f.cli.cli }, f.dir);
  assert.equal(run.code, 0, run.stderr);
  return JSON.parse(fs.readFileSync(path.join(f.out, 'review.json'), 'utf8'));
}

test('request/run/post preserves validated native context and its provenance with no CI results', async t => {
  const f = await setup(t);
  const called = { ...f.env, CALLED_PR: '7', CALLED_SHA: f.head, CALLED_BASE: f.base };
  const request = await ciReview(['request'], called, f.dir);
  assert.equal(request.code, 0, request.stderr);
  assert.ok(request.output.includes(`sha=${f.head}\nbase=${f.base}\n`));
  const saved = await runContext(f);
  assert.equal(saved.tests, null); assert.equal(saved.checkUsage, undefined);
  const local = fs.readFileSync(path.join(f.out, 'review.md'), 'utf8').trimEnd();
  assert.match(local, /selected native evidence.*coverage.*unknown/i);
  const post = await ciReview(['post', f.out], f.env, f.dir);
  assert.equal(post.code, 0, post.stderr);
  assert.equal(f.github.reviews.length, 1);
  const posted = f.github.reviews[0].body;
  assert.equal(posted, local, 'the public body must retain the same evidence as review.md');
  assert.doesNotMatch(posted, /with no test results|Every changed line.*was run/);
  for (const pinned of [f.context.guide.commit, f.context.guide.sha256,
    f.context.evidence[0].source.path, f.context.evidence[0].source.sha256,
    'selected-linux', saved.context.promptSha256])
    assert.ok(posted.includes(pinned), 'the body names the supplied guide, source and input receipt');
});

test('post rejects incomplete or mismatched context before publishing and preserves legacy no-context output',
async t => {
  const f = await setup(t);
  await runContext(f);
  const names = ['review.json', 'review-context.json', 'review-context-receipt.json'];
  const original = Object.fromEntries(names.map(name => [name, fs.readFileSync(path.join(f.out, name), 'utf8')]));
  const restore = () => names.forEach(name => fs.writeFileSync(path.join(f.out, name), original[name]));
  const change = (name, edit) => {
    const value = JSON.parse(original[name]); edit(value);
    fs.writeFileSync(path.join(f.out, name), JSON.stringify(value));
  };
  const secret = `sk-ant-${'x'.repeat(32)}`;
  const mutations = [
    () => fs.rmSync(path.join(f.out, names[1])),
    () => fs.rmSync(path.join(f.out, names[2])),
    () => change(names[0], value => { delete value.context; }),
    () => change(names[0], value => { value.head = 'd'.repeat(40); }),
    () => change(names[0], value => { value.context.head = 'd'.repeat(40); }),
    () => change(names[1], value => { value.guide.text += 'changed'; }),
    () => change(names[2], value => { value.promptSha256 = 'd'.repeat(64); }),
    () => change(names[2], value => { value.guide.sha256 = 'd'.repeat(64); }),
    () => change(names[2], value => { value.providerCompleted = false; }),
    () => change(names[2], value => { value.modelAcceptanceClaimed = true; }),
    () => change(names[2], value => { value.evidence[0].nativeRun.commit = 'd'.repeat(40); }),
    () => fs.writeFileSync(path.join(f.out, names[2]), `{"broken":"${secret}"`),
    () => fs.writeFileSync(path.join(f.out, names[1]), 'x'.repeat(48 * 1024 + 1)),
  ];
  for (const mutate of mutations) {
    restore(); mutate();
    const post = await ciReview(['post', f.out], f.env, f.dir);
    assert.equal(post.code, 1, 'invalid context cannot become a posted review');
    assert.match(post.stderr, /Review context:/);
    assert.ok(!post.stderr.includes(secret));
    assert.doesNotMatch(post.stdout, /AI review of/);
    assert.equal(f.github.reviews.length, 0);
  }
  t.diagnostic(`${mutations.length} invalid companion/provenance cases rejected before publication.`);
  restore(); change(names[0], value => { delete value.context; });
  fs.rmSync(path.join(f.out, names[1])); fs.rmSync(path.join(f.out, names[2]));
  const legacy = await ciReview(['post', f.out], f.env, f.dir);
  assert.equal(legacy.code, 0, legacy.stderr);
  assert.match(f.github.reviews[0].body, /with no test results/);
  assert.doesNotMatch(f.github.reviews[0].body, /Pinned guide|Input receipt/);
});
