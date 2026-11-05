import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function report({ failList, malformedCoverage = false, note = 'not selected' } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-comment-resilience-'));
  const write = (name, text) => {
    const file = path.join(folder, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write('results-ubuntu-latest/suite/results.json', JSON.stringify({ files: [
    { path: 'test/a.js', success: true, skipped: ['optional tool unavailable'] },
    { path: 'test/b.js', success: false, skipped: [], outputTail: 'Error: expected failure' },
  ], excluded: [] }));
  write('results-ubuntu-latest/docker/results.json', JSON.stringify({ suite: 'docker', files: [], notRun: note }));
  const metric = { covered: 1, total: 2 };
  write('coverage-ubuntu-latest/coverage-summary.json', malformedCoverage ? '{' : JSON.stringify({
    total: { lines: metric, branches: metric, functions: metric },
  }));
  const server = http.createServer((req, res) => {
    const kind = req.url.includes('/jobs') ? 'jobs' : 'artifacts';
    res.writeHead(kind === failList ? 503 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(kind === failList ? { message: 'metadata unavailable' } : { [kind]: [] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, 'test/ci-comment.js'), folder], {
        cwd: root,
        env: { ...process.env, PR: '', GH_TOKEN: 'fixture', GITHUB_REPOSITORY: 'o/r', RUN_ID: '42',
          HEAD_SHA: 'a'.repeat(40), TESTS: '', TESTS_FROM: '',
          GITHUB_API_URL: `http://127.0.0.1:${server.address().port}` },
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, stdout, stderr }));
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

function localResults(output) {
  assert.equal(output.code, 0, output.stderr);
  assert.match(output.stdout, /1 of 2 files passed/);
  assert.match(output.stdout, /1 check skipped/);
  assert.match(output.stdout, /test\/b\.js/);
  assert.match(output.stdout, /expected failure/);
}

for (const failList of ['jobs', 'artifacts']) {
  test(`${failList} metadata failure preserves the local job summary and failed-file evidence`, async () => {
    const output = await report({ failList });
    localResults(output);
    assert.match(output.stdout, /50 %/);
    assert.ok(output.stdout.includes(`${failList} metadata unavailable`));
    assert.match(output.stderr, /503/);
  });
}

test('malformed coverage does not hide local results or invent coverage', async () => {
  const output = await report({ malformedCoverage: true });
  localResults(output);
  assert.match(output.stdout, /\| Linux \| – \| – \| – \|/);
});

test('artifact notes cannot render links or images in a results cell', async () => {
  const output = await report({ note: '![status](https://example.invalid/image) [details](https://example.invalid)' });
  localResults(output);
  assert.ok(!output.stdout.includes('![status]') && !output.stdout.includes('[details]'));
  assert.match(output.stdout, /Docker: !status\(https:\/\/example\.invalid\/image\)/);
});
