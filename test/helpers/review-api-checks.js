/** Integration checks shared by the review's existing repository-specific test suite. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export async function reviewApiChecks({ ciReview, dir, repo, base, head, out, api }) {
  const source = fs.existsSync(path.join(repo, 'src/server/a.ts')) ? 'src/server/a.ts' : 'src/a.ts';
  let requests = [];
  let status = 200;
  let mode = 'review';
  const reviewed = {
    summary: 'One bug.',
    findings: [{ kind: 'real bug', file: `pr/${source}`, line: 2, text: 'two is 2.' }],
  };
  const textAnswer = {
    summary: 'Evidence missing.',
    findings: [{ kind: 'not checked', line: 2, text: 'No own-head result supplied.' }],
    checked: [{ claim: 'Adds b.', line: 1, evidence: 'src/b.ts:1' }],
  };
  const answerFor = () => {
    if (mode === 'text' || mode === 'git') return textAnswer;
    if (mode === 'secret') return { summary: 'local-test-key', findings: [] };
    if (mode === 'invalid') return { summary: 'Missing findings.' };
    if (mode === 'clean') return { summary: 'Checked.', findings: [] };
    return reviewed;
  };
  const server = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ body, headers: request.headers, url: request.url });
    response.setHeader('Content-Type', 'application/json');
    response.statusCode = status;
    const callResult = body.input.find((item) => item.type === 'function_call_output');
    let output;
    if (mode === 'read' && !callResult)
      output = [
        {
          type: 'function_call',
          name: 'read_file',
          arguments: JSON.stringify({ path: `pr/${source}` }),
          call_id: 'frozen',
        },
        { type: 'function_call', name: 'read_file', arguments: JSON.stringify({ path: 'pr/link' }), call_id: 'link' },
      ];
    else if (mode === 'git' && !callResult)
      output = [
        {
          type: 'function_call',
          name: 'run_shell_command',
          arguments: JSON.stringify({ command: `git log -1 --format=%P ${head}` }),
          call_id: 'parents',
        },
      ];
    else
      output = [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: JSON.stringify(answerFor()),
            },
          ],
        },
      ];
    response.end(
      JSON.stringify({
        status: mode === 'incomplete' ? 'incomplete' : 'completed',
        output,
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, output_tokens_details: { reasoning_tokens: 2 } },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/responses`;
  const run = (options = [], env = {}, range = `${base}..${head}`) =>
    ciReview(
      ['run', range, '--repo', repo, '--out', out, ...options],
      { OPENAI_API_KEY: 'local-test-key', REVIEW_OPENAI_URL: endpoint, PR: '', ...env },
      dir,
    );
  const reset = () => {
    requests = [];
    fs.rmSync(out, { recursive: true, force: true });
  };
  try {
    const summary = path.join(dir, 'openai-summary.md');
    fs.writeFileSync(summary, '');
    let done = await run([], { OPENAI_API_KEY: '', GITHUB_STEP_SUMMARY: summary });
    assert.equal(done.code, 1);
    assert.match(done.stderr, /No OpenAI API key/);
    assert.match(done.stderr, /OPENAI_API_KEY/);
    assert.match(fs.readFileSync(summary, 'utf8'), /AI review: not done/);
    assert.equal(requests.length, 0);
    assert.ok(!fs.existsSync(out));

    // The working file differs from B; the tool must still read B's exported version.
    fs.writeFileSync(path.join(repo, source), 'uncommitted checkout change\n');
    mode = 'read';
    done = await run();
    assert.equal(done.code, 0, done.stderr);
    assert.equal(requests[0].headers.authorization, 'Bearer local-test-key');
    assert.equal(requests[0].body.model, 'gpt-6.1-sol');
    assert.deepEqual(requests[0].body.reasoning, { effort: 'medium' });
    assert.ok(requests[0].body.tools.every((tool) => tool.name !== 'run_shell_command'));
    const frozen = requests[1].body.input.find(
      (item) => item.type === 'function_call_output' && item.call_id === 'frozen',
    );
    assert.match(frozen.output, /export const two = 2/);
    assert.ok(!frozen.output.includes('uncommitted'));
    assert.equal(requests[1].body.input.at(-1).output, '1: ../../secret');
    assert.ok(!JSON.stringify(requests[0].body).includes('local-test-key'));
    const saved = JSON.parse(fs.readFileSync(path.join(out, 'review.json'), 'utf8'));
    assert.equal(saved.head, head);
    assert.equal(saved.base, base);
    assert.equal(saved.findings[0].file, source);
    assert.equal(saved.usage.total, 30);
    assert.equal(saved.tests, null);
    assert.ok(fs.existsSync(path.join(out, 'answer.json')) && fs.existsSync(path.join(out, 'session.jsonl')));

    reset();
    mode = 'review';
    done = await run([], {
      OPENAI_API_KEY: 'ci-test-key',
      REVIEW_MODEL: 'gpt-6-luna',
      REVIEW_REASONING_EFFORT: 'low',
      PR: '7',
      ...api,
    });
    assert.equal(done.code, 0, done.stderr);
    assert.equal(requests[0].headers.authorization, 'Bearer ci-test-key');
    assert.equal(requests[0].body.model, 'gpt-6-luna');
    assert.equal(requests[0].body.reasoning.effort, 'low');

    for (const failure of ['http', 'incomplete', 'secret', 'invalid']) {
      if (failure !== 'http') reset();
      requests = [];
      mode = failure;
      status = failure === 'http' ? 429 : 200;
      done = await run([], { GITHUB_STEP_SUMMARY: summary });
      assert.equal(done.code, 1, `${failure} must fail`);
      assert.ok(!fs.existsSync(path.join(out, 'review.json')));
      const artifacts = fs
        .readdirSync(out)
        .map((file) => fs.readFileSync(path.join(out, file), 'utf8'))
        .join('');
      assert.ok(!`${artifacts}${done.stderr}`.includes('local-test-key'));
    }
    status = 200;
    reset();
    mode = 'text';
    const text = path.join(dir, 'claims.md');
    const results = path.join(dir, 'evidence.md');
    fs.writeFileSync(text, 'Adds b.\nAll tests passed.\n');
    fs.writeFileSync(results, 'No own-head result supplied.');
    done = await run(['--text', text, '--results', results]);
    assert.equal(done.code, 0, done.stderr);
    assert.match(fs.readFileSync(path.join(out, 'text-check.md'), 'utf8'), /not checked/i);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(out, 'text-check.json'), 'utf8')).findings[0].kind,
      'not checked',
    );
    assert.ok(!fs.existsSync(path.join(out, 'review.json')));
    assert.ok(requests[0].body.input[0].content.includes('evidence.md'));
    reset();
    mode = 'git';
    done = await run(['--text', text]);
    assert.equal(done.code, 0, done.stderr);
    assert.equal(requests[1].body.input.at(-1).output.trim(), base);
    reset();
    mode = 'clean';
    const artifacts = path.join(dir, 'coverage-artifacts');
    fs.mkdirSync(path.join(artifacts, 'results-ubuntu-latest', 'suite'), { recursive: true });
    fs.mkdirSync(path.join(artifacts, 'coverage-ubuntu-latest'), { recursive: true });
    fs.writeFileSync(
      path.join(artifacts, 'results-ubuntu-latest/suite/results.json'),
      JSON.stringify({ files: [{ path: 'test/test-a.js', success: true, skipped: [] }] }),
    );
    fs.writeFileSync(
      path.join(artifacts, 'coverage-ubuntu-latest/lcov.info'),
      `SF:/w/r/${source}\nDA:1,1\nDA:2,0\nend_of_record\n`,
    );
    done = await run(['--tests', artifacts]);
    assert.equal(done.code, 0, done.stderr);
    const coverageReview = JSON.parse(fs.readFileSync(path.join(out, 'review.json'), 'utf8'));
    assert.deepEqual(coverageReview.tests.platforms, ['ubuntu-latest']);
    assert.equal(coverageReview.findings[0].kind, 'not covered');
    assert.equal(coverageReview.findings[0].file, source);
    reset();
    done = await run([], { REVIEW_MAX_PROMPT_TOKENS: '100' });
    assert.equal(done.code, 1);
    assert.match(done.stderr, /Too big to review/);
    assert.equal(requests.length, 0);
    for (const range of ['main', '..x', `${base}...${head}`, '-x..y']) {
      done = await run([], {}, range);
      assert.equal(done.code, 1);
    }
    console.log(
      '✓ OpenAI API review: frozen head, CI/local keys, model/effort, failures, text evidence, read-only git',
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
