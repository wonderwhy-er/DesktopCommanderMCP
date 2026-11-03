import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { askResponses } from './helpers/openai-review.js';
import { allowedRead, readTool, toolEnvironment } from './helpers/review-tools.js';

const answer = { summary: 'Checked.', findings: [] };
const message = (value = answer) => ({
  type: 'message',
  content: [{ type: 'output_text', text: JSON.stringify(value) }],
});
const call = (name, args = {}) => ({ type: 'function_call', name, arguments: JSON.stringify(args), call_id: 'c1' });
const reply = (output, rest = {}) => ({
  ok: true,
  status: 200,
  json: async () => ({ status: 'completed', output, ...rest }),
});
const rejected = (code, headers = {}, status = 429, fields = {}) => ({
  ok: false,
  status,
  headers: new Headers(headers),
  json: async () => ({
    error: { type: 'rate_limit_error', code, param: 'input', message: 'secret test-key', ...fields },
  }),
});

test('a transient limit waits for project reset and retries the same operation without repeating reads', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'review-retry-test-'));
  const requests = [];
  const waits = [];
  try {
    fs.mkdirSync(path.join(folder, 'pr'));
    fs.writeFileSync(path.join(folder, 'pr/a.txt'), 'read once');
    const result = await askResponses({
      prompt: 'Review JSON.',
      key: 'test-key',
      folder,
      out: path.join(folder, 'out'),
      maxTurns: 3,
      random: () => 0,
      sleepImpl: async (ms) => waits.push(ms),
      fetchImpl: async (url, options) => {
        requests.push({ body: options.body, operation: options.headers['X-Client-Request-Id'] });
        if (requests.length === 1) return reply([call('read_file', { path: 'pr/a.txt' })]);
        if (requests.length === 2) {
          fs.rmSync(path.join(folder, 'pr/a.txt'));
          return rejected('rate_limit_exceeded', {
            'retry-after': '2',
            'x-ratelimit-reset-tokens': '3s',
            'x-ratelimit-reset-project-tokens': '4s',
            'x-ratelimit-limit-project-tokens': '60000',
          });
        }
        return reply([message()]);
      },
    });
    assert.equal(result.response, JSON.stringify(answer));
    assert.deepEqual(waits, [4000]);
    assert.equal(requests[1].body, requests[2].body);
    assert.ok(requests[1].operation);
    assert.equal(requests[1].operation, requests[2].operation);
    assert.notEqual(requests[0].operation, requests[1].operation);
    assert.equal(JSON.parse(requests[2].body).input.filter((item) => item.type === 'function_call_output').length, 1);
    assert.match(JSON.parse(requests[2].body).input.at(-1).output, /read once/);
    const diagnostics = fs.readFileSync(path.join(folder, 'out/rate-limits.json'), 'utf8');
    assert.ok(diagnostics.includes('rate_limit_exceeded') && !diagnostics.includes('test-key'));
    assert.equal(result.stats.models['gpt-6.1-sol'].api.totalRequests, 3);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

for (const [name, code, status] of [
  ['quota', 'insufficient_quota', 429],
  ['unknown 429', 'unrecognized', 429],
  ['authentication', 'invalid_api_key', 401],
]) {
  test(`${name} errors fail once with sanitized fields and never retry`, async () => {
    let requests = 0;
    await assert.rejects(
      askResponses({
        prompt: 'Review JSON.',
        key: 'test-key',
        folder: os.tmpdir(),
        sleepImpl: async () => assert.fail('must not sleep'),
        fetchImpl: async () => {
          requests += 1;
          return rejected(code, { 'retry-after': '1' }, status);
        },
      }),
      (error) =>
        error.message.includes(`HTTP ${status}`) &&
        !error.message.includes('test-key') &&
        error.message.includes(name === 'unknown 429' ? 'unknown' : code),
    );
    assert.equal(requests, 1);
  });
}

test('a provider delay beyond the deadline is reported and never shortened or retried', async () => {
  let requests = 0;
  await assert.rejects(
    askResponses({
      prompt: 'Review JSON.',
      key: 'test-key',
      folder: os.tmpdir(),
      timeoutMs: 50,
      sleepImpl: async () => assert.fail('must not sleep'),
      fetchImpl: async () => {
        requests += 1;
        return rejected('rate_limit_exceeded', { 'retry-after': '60' });
      },
    }),
    /rate_limit_exceeded.*deadline|deadline.*rate_limit_exceeded/,
  );
  assert.equal(requests, 1);
});

test('HTTP-date Retry-After is respected and waiting remains cancelable by the overall deadline', async () => {
  const waits = [];
  let requests = 0;
  const after = new Date(Date.now() + 5000).toUTCString();
  await askResponses({
    prompt: 'Review JSON.',
    key: 'test-key',
    folder: os.tmpdir(),
    random: () => 0,
    sleepImpl: async (ms) => waits.push(ms),
    fetchImpl: async () => {
      requests += 1;
      return requests === 1 ? rejected('slow_down', { 'retry-after': after }) : reply([message()]);
    },
  });
  assert.ok(waits[0] >= 3000 && waits[0] <= 5000);
  await assert.rejects(
    askResponses({
      prompt: 'Review JSON.',
      key: 'test-key',
      folder: os.tmpdir(),
      timeoutMs: 30,
      random: () => 0,
      sleepImpl: (ms, signal) =>
        new Promise((resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
        ),
      fetchImpl: async () => rejected('rate_limit_exceeded', { 'retry-after': '0.001' }),
    }),
    /within/,
  );
});

test('transient retries consume the existing request budget and use exponential backoff', async () => {
  let requests = 0;
  const waits = [];
  await assert.rejects(
    askResponses({
      prompt: 'Review JSON.',
      key: 'test-key',
      folder: os.tmpdir(),
      maxTurns: 3,
      random: () => 0,
      sleepImpl: async (ms) => waits.push(ms),
      fetchImpl: async () => {
        requests += 1;
        return rejected('rate_limit_exceeded');
      },
    }),
    /request budget/,
  );
  assert.equal(requests, 3);
  assert.deepEqual(waits, [1000, 2000]);
});

test('error fields and rate headers cannot echo a credential into failure artifacts', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'review-error-test-'));
  try {
    await assert.rejects(
      askResponses({
        prompt: 'Review JSON.',
        key: 'test-key',
        folder,
        out: folder,
        fetchImpl: async () =>
          rejected('test-key', { 'retry-after': 'test-key', 'x-ratelimit-remaining-tokens': 'test-key' }, 429, {
            type: 'test-key',
            param: 'test-key',
          }),
      }),
      (error) => !error.message.includes('test-key'),
    );
    const diagnostics = fs.readFileSync(path.join(folder, 'rate-limits.json'), 'utf8');
    assert.ok(!diagnostics.includes('test-key'));
    assert.ok(!fs.readFileSync(path.join(folder, 'answer.json'), 'utf8').includes('test-key'));
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('CI review posting requires an explicit repository opt-in after artifact checks', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/review.yml'), 'utf8');
  assert.ok(
    workflow.includes("if: inputs.check != 'text' && vars.REVIEW_POST_ENABLED == 'true'"),
    'Posting requires explicit repository opt-in.',
  );
});

test('every workflow sparse checkout can run the request command without API modules or credentials', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'review-sparse-test-'));
  try {
    for (const name of ['review.yml', 'tests.yml']) {
      const workflow = fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8');
      const blocks = [...workflow.matchAll(/sparse-checkout: \|\r?\n((?:[ \t]+\/[^\r\n]*\r?\n)+)/g)];
      assert.ok(blocks.length > 0, name);
      for (const [index, block] of blocks.entries()) {
        const checkout = path.join(folder, name, String(index));
        for (const line of block[1].trim().split(/\r?\n/)) {
          const file = line.trim().slice(1);
          const destination = path.join(checkout, file);
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.copyFileSync(path.join(root, file), destination);
        }
        const command = spawnSync(process.execPath, ['test/ci-review.js', 'request'], {
          cwd: checkout,
          encoding: 'utf8',
          env: {
            ...process.env,
            OPENAI_API_KEY: '',
            UNRELATED_API_KEY: '',
            CALLED_PR: '7',
            CALLED_SHA: '1'.repeat(40),
            CALLED_BASE: '2'.repeat(40),
            GITHUB_OUTPUT: '',
          },
        });
        assert.equal(command.status, 0, `${name} checkout ${index}: ${command.stderr}`);
        assert.match(command.stdout, /review=true/);
      }
    }
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('Responses reads the frozen files, continues with call_id, and preserves model and usage', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'responses-test-'));
  try {
    fs.mkdirSync(path.join(folder, 'pr'));
    fs.writeFileSync(path.join(folder, 'pr', 'file.js'), 'frozen head\n');
    const requests = [];
    const fetchImpl = async (url, options) => {
      requests.push({ url, ...options, body: JSON.parse(options.body) });
      return requests.length === 1
        ? reply([call('read_file', { path: 'pr/file.js' })])
        : reply([message()], {
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              total_tokens: 15,
              output_tokens_details: { reasoning_tokens: 2 },
            },
          });
    };
    const result = await askResponses({
      prompt: 'Review.',
      key: 'test-key',
      folder,
      fetchImpl,
      model: 'gpt-6.1-sol',
      effort: 'medium',
    });
    assert.equal(result.response, JSON.stringify(answer));
    assert.equal(requests[0].url, 'https://api.openai.com/v1/responses');
    assert.equal(requests[0].headers.Authorization, 'Bearer test-key');
    assert.equal(requests[0].body.model, 'gpt-6.1-sol');
    assert.deepEqual(requests[0].body.reasoning, { effort: 'medium' });
    assert.equal(requests[0].body.store, false);
    assert.equal(requests[1].body.input.at(-1).call_id, 'c1');
    assert.match(requests[1].body.input.at(-1).output, /frozen head/);
    assert.equal(result.stats.models['gpt-6.1-sol'].tokens.total, 15);
    assert.equal(result.stats.models['gpt-6.1-sol'].tokens.candidates, 3);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('HTTP errors, incomplete responses, refusals and secret echoes never yield an answer', async () => {
  for (const fetchImpl of [
    async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'test-key' } }) }),
    async () => reply([message()], { status: 'incomplete' }),
    async () => reply([{ type: 'message', content: [{ type: 'refusal', refusal: 'No.' }] }]),
    async () => reply([message({ summary: 'test-key', findings: [] })]),
  ]) {
    await assert.rejects(
      askResponses({ prompt: 'Review.', key: 'test-key', folder: os.tmpdir(), fetchImpl }),
      (error) => !error.message.includes('test-key'),
    );
  }
});

test('all tools consume the budget; writes and shell calls in code review are denied', async () => {
  const requests = [];
  const result = await askResponses({
    prompt: 'Review.',
    key: 'test-key',
    folder: os.tmpdir(),
    calls: 1,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      return requests.length < 3 ? reply([call('write_file', { path: '/tmp/no', content: 'x' })]) : reply([message()]);
    },
  });
  assert.equal(result.response, JSON.stringify(answer));
  assert.match(requests[1].input.at(-1).output, /denied/i);
  assert.match(requests[2].input.at(-1).output, /budget/i);
  assert.equal(requests[1].tool_choice, 'none');
  assert.match(
    await readTool({ folder: os.tmpdir(), name: 'run_shell_command', args: { command: 'echo hi' } }),
    /denied/i,
  );
});

test('tool paths cannot escape, symlinks cannot escape, and results cannot carry secrets', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'read-tool-test-'));
  try {
    fs.mkdirSync(path.join(folder, 'pr'));
    fs.writeFileSync(path.join(folder, 'pr', 'key.txt'), 'test-key');
    assert.match(await readTool({ folder, name: 'read_file', args: { path: '../outside' } }), /denied/i);
    assert.match(
      await readTool({ folder, name: 'read_file', args: { path: path.join(folder, 'pr', 'key.txt') } }),
      /denied/i,
    );
    const requests = [];
    await askResponses({
      prompt: 'Review.',
      key: 'test-key',
      folder,
      fetchImpl: async (url, options) => {
        requests.push(JSON.parse(options.body));
        return requests.length === 1 ? reply([call('read_file', { path: 'pr/key.txt' })]) : reply([message()]);
      },
    });
    assert.ok(!requests[1].input.at(-1).output.includes('test-key'));
    if (process.platform !== 'win32') {
      fs.symlinkSync(os.tmpdir(), path.join(folder, 'pr', 'link'));
      assert.match(await readTool({ folder, name: 'list_directory', args: { path: 'pr/link' } }), /denied/i);
    }
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('read broker refuses commands that can write, change repositories or start configured programs', async () => {
  for (const command of [
    'git show --output=file',
    'git show --textconv HEAD',
    'git log --show-signature',
    'git log --ext-diff',
    'git show -Ofile',
    'gh pr view -Rother/repo',
    'gh run view --repo=other/repo',
    'gh pr view https://github.com/other/repo/pull/1 --json=body',
    'gh pr view --web',
    'git show HEAD; echo bad',
    'git show $(echo bad)',
  ]) {
    assert.equal(allowedRead(command), false, command);
  }
  for (const command of [
    'git log -1 --format=%P HEAD',
    'git show HEAD:src/a.ts',
    'git merge-base --is-ancestor HEAD main',
    'gh pr view 7 --json title,body',
    'gh run view 17 --json=headSha,conclusion',
    'gh run view 17 --log',
  ]) {
    assert.equal(allowedRead(command), true, command);
  }
});

test('read subprocesses inherit only system paths, and only gh receives its explicit read token', () => {
  const environment = {
    PATH: 'system-path',
    HOME: 'user-home',
    OPENAI_API_KEY: 'api-secret',
    UNRELATED_API_KEY: 'local-secret',
    GH_TOKEN: 'inherited-token',
    DATABASE_PASSWORD: 'db-secret',
  };
  const options = { folder: os.tmpdir(), gitDir: 'git-dir', repo: 'owner/repo', token: 'read-token', environment };
  const git = toolEnvironment({ ...options, executable: 'git' });
  const gh = toolEnvironment({ ...options, executable: 'gh' });
  for (const env of [git, gh]) {
    for (const name of ['OPENAI_API_KEY', 'UNRELATED_API_KEY', 'DATABASE_PASSWORD']) assert.ok(!(name in env), name);
    assert.equal(env.PATH, 'system-path');
  }
  assert.ok(!('GH_TOKEN' in git));
  assert.equal(gh.GH_TOKEN, 'read-token');
  assert.equal(gh.GH_REPO, 'owner/repo');
});

test('timeout and turn exhaustion fail; invalid model effort fails before a request', async () => {
  await assert.rejects(
    askResponses({
      prompt: 'Review.',
      key: 'test-key',
      folder: os.tmpdir(),
      timeoutMs: 20,
      fetchImpl: (url, options) =>
        new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))),
    }),
    /within/,
  );
  await assert.rejects(
    askResponses({
      prompt: 'Review.',
      key: 'test-key',
      folder: os.tmpdir(),
      maxTurns: 2,
      fetchImpl: async () => reply([call('write_file')]),
    }),
    /turns/,
  );
  await assert.rejects(
    askResponses({
      prompt: 'Review.',
      key: 'test-key',
      folder: os.tmpdir(),
      effort: 'none',
      fetchImpl: () => {
        throw new Error('must not call');
      },
    }),
    /effort/,
  );
});
