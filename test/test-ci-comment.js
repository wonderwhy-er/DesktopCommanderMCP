/**
 * CI's PR comment (ci-comment.js), against a stand-in for GitHub's API on this
 * machine: it writes one comment from the run's artifacts, edits it on the next
 * run keeping the platforms that didn't run, leaves it alone when the PR has moved
 * on, and puts the comment in the job summary once, also when it may not post.
 */
import assert from 'assert';
import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { dataOf, MARKER, renderComment } from './helpers/ci-platforms.js';
import { ROOT } from './helpers/node-test-runner.js';
import { runIfMain } from './helpers/run-if-main.js';
import { createTempDir } from './helpers/test-env.js';

const HEAD = '0123456789abcdef0123456789abcdef01234567';
const OLDER = 'f'.repeat(40);
const metric = (covered, total) => ({ covered, total, skipped: 0, pct: 0 });

/** The run's artifacts as the comment job downloads them: Linux's results and coverage */
function artifacts(dir) {
  const write = (file, data) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), JSON.stringify(data));
  };
  // The suite left one excluded test out; the comment counts it
  write('results-ubuntu-latest/suite/results.json', { files: [
    { path: 'test/test-a.js', success: true, skipped: [] },
    { path: 'test/test-b.js', success: true, skipped: ['no python'] },
  ], excluded: [{ name: 'test-c.js', reason: 'needs a service CI doesn\'t have' }] });
  const lines = metric(30, 40);
  // Docker's part, with no Docker tests at this commit: nothing ran, and its reports say why
  write('results-ubuntu-latest/docker/results.json', { suite: 'docker', files: [], notRun: 'no Docker tests at this commit' });
  write('coverage-ubuntu-latest/coverage-summary.json', {
    total: { lines, statements: lines, branches: metric(1, 2), functions: metric(3, 4) },
    [path.join(ROOT, 'src', 'tools', 'edit.ts')]: { lines, statements: lines, branches: metric(1, 2), functions: metric(3, 4) },
  });
}

/** A stand-in for GitHub's API: the run's jobs and artifacts, the PR, its comments; it records what's written */
function fakeGitHub({
  prHead = HEAD, comments = [], refuseWrites = false,
  jobs = [{ name: 'unit (ubuntu-latest)', conclusion: 'success', started_at: '2026-10-30T04:00:00Z', completed_at: '2026-10-30T04:12:29Z', steps: [] }],
  artifacts: runArtifacts = [{ name: 'coverage-ubuntu-latest', id: 5 }, { name: 'results-ubuntu-latest', id: 6 }],
}) {
  const written = [];
  const server = http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'POST' || req.method === 'PATCH') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        if (refuseWrites) return send(403, { message: 'Resource not accessible by integration' });
        written.push({ method: req.method, url: req.url, body: JSON.parse(body).body });
        send(200, {});
      });
      return;
    }
    if (req.url.includes('/jobs')) return send(200, { jobs });
    if (req.url.includes('/artifacts')) return send(200, { artifacts: runArtifacts });
    if (req.url.includes('/comments')) return send(200, comments);
    if (req.url.includes('/pulls/')) return send(200, { head: { sha: prHead } });
    return send(404, {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, written, url: `http://127.0.0.1:${server.address().port}` })));
}

/** ci-comment.js on the artifacts folder: its exit code, stdout (the job summary) and stderr */
function comment(dir, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'test', 'ci-comment.js'), dir], {
      cwd: ROOT,
      env: { ...process.env, GITHUB_REPOSITORY: 'o/r', GITHUB_SERVER_URL: 'https://github.com', RUN_ID: '42', HEAD_SHA: HEAD, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const LINUX_ROW = '| Linux | ✅ 2 of 2 files passed; Docker: no Docker tests at this commit; 1 excluded (test/excluded.txt); 1 check skipped | `everything` | 12 | `0123456` | [run](https://github.com/o/r/actions/runs/42) |';

export default async function run() {
  const dir = createTempDir('dc-ci-comment-');
  artifacts(dir);
  try {
    // Without a PR or a token: the comment in the summary, nothing written
    // TESTS empty: the default, everything a push or label run runs
    const local = await comment(dir, { PR: '', GH_TOKEN: '', TESTS: '' });
    assert.strictEqual(local.code, 0, local.stderr);
    assert.ok(local.stdout.startsWith(`${MARKER}\n## Tests and coverage for \`0123456\``) && local.stdout.includes('| Linux | ✅ 2 of 2 files passed; Docker: no Docker tests at this commit; 1 excluded (test/excluded.txt); 1 check skipped | `everything` | – |'),
      `the comment from the artifacts, \`everything\` for an empty TESTS, no minutes without the run's jobs:\n${local.stdout}`);
    console.log('✓ without a PR or a token: the comment in the summary only');

    // tests=timed: one job per timed test, each with its own results artifact; the platform's row counts them all
    const timedDir = createTempDir('dc-ci-comment-timed-');
    try {
      const timedResult = (artifact, part, file, success) => {
        fs.mkdirSync(path.join(timedDir, artifact, part), { recursive: true });
        fs.writeFileSync(path.join(timedDir, artifact, part, 'results.json'), JSON.stringify({ suite: part, files: [{ path: file, success, skipped: [] }], excluded: [] }));
      };
      timedResult('results-ubuntu-latest-timed-test-a.js', 'suite', 'test/test-a.js', true);
      timedResult('results-ubuntu-latest-timed-repro-test-b.js', 'repro', 'test/repro/test-b.js', false);
      timedResult('results-macos-latest-timed-test-a.js', 'suite', 'test/test-a.js', true);
      const timed = await comment(timedDir, { PR: '', GH_TOKEN: '', TESTS: 'timed' });
      assert.strictEqual(timed.code, 0, timed.stderr);
      assert.ok(timed.stdout.includes('| Linux | ❌ 1 of 2 files passed | `timed` | – |') && timed.stdout.includes('| macOS | ✅ 1 of 1 files passed | `timed` | – |'),
        `each platform's timed jobs in its one row:\n${timed.stdout}`);

      // A timed job that stopped before its tests ran (here at Install) uploads no results: its row says so, not ✅
      fs.rmSync(path.join(timedDir, 'results-ubuntu-latest-timed-repro-test-b.js'), { recursive: true });
      timedResult('results-ubuntu-latest-timed-repro-test-b.js', 'repro', 'test/repro/test-b.js', true);
      const timedJob = (test, conclusion, steps = []) => ({
        name: `unit (ubuntu-latest, ${test})`, conclusion, steps, started_at: '2026-10-30T04:00:00Z', completed_at: '2026-10-30T04:04:00Z',
      });
      const api = await fakeGitHub({
        jobs: [timedJob('test-a.js', 'success'), timedJob('repro/test-b.js', 'success'),
          timedJob('test-c.js', 'failure', [{ name: 'Install', conclusion: 'failure' }])],
        artifacts: [{ name: 'results-ubuntu-latest-timed-test-a.js', id: 7 }, { name: 'results-ubuntu-latest-timed-repro-test-b.js', id: 8 }],
      });
      try {
        const stopped = await comment(timedDir, { PR: '', GH_TOKEN: 'x', GITHUB_API_URL: api.url, TESTS: 'timed' });
        assert.strictEqual(stopped.code, 0, stopped.stderr);
        assert.ok(stopped.stdout.includes('| Linux | ❌ 2 of 3 files passed; test-c.js: “Install” failed | `timed` | 4 |'),
          `a timed job with no results is a failure, named with its step:\n${stopped.stdout}`);
        assert.ok(stopped.stdout.includes('(https://github.com/o/r/actions/runs/42#artifacts)'), 'a timed run\'s results: the run\'s artifacts, one per job');
      } finally {
        api.server.close();
      }
    } finally {
      fs.rmSync(timedDir, { recursive: true, force: true });
    }
    console.log('✓ tests=timed: a platform\'s row counts every timed job\'s results, and a job that stopped before its tests');

    // The three platforms combined: only from this run's own three coverage-final.json files
    assert.ok(local.stdout.includes('| **Combined** | – | – | – | needs Linux, Windows and macOS in one run | – |'), 'Linux alone: no combined figure');
    const threeDir = createTempDir('dc-ci-comment-three-');
    try {
      const final = (os, hits) => {
        const file = path.join(ROOT, 'src', 'tools', 'edit.ts');
        const loc = (line) => ({ start: { line, column: 0 }, end: { line, column: 5 } });
        fs.mkdirSync(path.join(threeDir, `coverage-${os}`), { recursive: true });
        fs.writeFileSync(path.join(threeDir, `coverage-${os}`, 'coverage-final.json'), JSON.stringify({ [file]: {
          path: file, statementMap: { 0: loc(1), 1: loc(2) }, s: { 0: hits[0], 1: hits[1] }, branchMap: {}, b: {}, fnMap: {}, f: {},
        } }));
        const lines = metric(hits.filter(Boolean).length, 2);
        fs.writeFileSync(path.join(threeDir, `coverage-${os}`, 'coverage-summary.json'), JSON.stringify({
          total: { lines, statements: lines, branches: metric(0, 0), functions: metric(0, 0) },
          [file]: { lines, statements: lines, branches: metric(0, 0), functions: metric(0, 0) },
        }));
        fs.mkdirSync(path.join(threeDir, `results-${os}`, 'suite'), { recursive: true });
        fs.writeFileSync(path.join(threeDir, `results-${os}`, 'suite', 'results.json'), JSON.stringify({ files: [{ path: 'test/test-a.js', success: true, skipped: [] }] }));
      };
      // Line 1 runs on Linux only, line 2 on Windows only: 50 % on each, 100 % combined
      final('ubuntu-latest', [1, 0]);
      final('windows-latest', [0, 1]);
      final('macos-latest', [0, 0]);
      const all = await comment(threeDir, { PR: '', GH_TOKEN: '', TESTS: '' });
      assert.strictEqual(all.code, 0, all.stderr);
      assert.ok(all.stdout.includes('| Linux | 50 % |') && all.stdout.includes('| **Combined** | 100 % | 100 % | 100 % | – | – |'), `the combined figure:\n${all.stdout}`);
      assert.ok(all.stdout.includes('| `src/tools` | 50 % (1/2) | 50 % (1/2) | 0 % (0/2) | 100 % (2/2) |'), 'and its column by area');
      // Fail closed: one report that can't be read gives no combined figure, and the row names it
      fs.writeFileSync(path.join(threeDir, 'coverage-windows-latest', 'coverage-final.json'), '{"cut off');
      const broken = await comment(threeDir, { PR: '', GH_TOKEN: '', TESTS: '' });
      assert.strictEqual(broken.code, 0, broken.stderr);
      assert.ok(broken.stdout.includes('| **Combined** | – | – | – | coverage-windows-latest can\'t be read | – |'), `no combined figure, the report named:\n${broken.stdout}`);
    } finally {
      fs.rmSync(threeDir, { recursive: true, force: true });
    }
    console.log('✓ the three platforms combined, only from this run\'s three reports; one unreadable gives none');

    // A cross-test (tests_from): the summary names the code's commit and the tests' commit
    const cross = await comment(dir, { PR: '', GH_TOKEN: '', TESTS: '', TESTS_FROM: OLDER });
    assert.strictEqual(cross.code, 0, cross.stderr);
    assert.ok(cross.stdout.includes('## Tests and coverage for `0123456`, tests from `fffffff`'), `both commits named:\n${cross.stdout.slice(0, 400)}`);
    console.log('✓ a cross-test\'s summary names both commits');

    // Fail closed: a job that failed while its results show no failure (a part that crashed before writing
    // its results.json), and a results.json that can't be read, each make the row ❌ and say so
    const closedDir = createTempDir('dc-ci-comment-closed-');
    const closedApi = await fakeGitHub({
      jobs: [
        { name: 'unit (ubuntu-latest)', conclusion: 'failure', steps: [{ name: 'Tests with coverage', conclusion: 'failure' }],
          started_at: '2026-10-30T04:00:00Z', completed_at: '2026-10-30T04:10:00Z' },
        { name: 'unit (macos-latest)', conclusion: 'success', steps: [], started_at: '2026-10-30T04:00:00Z', completed_at: '2026-10-30T04:10:00Z' },
      ],
      artifacts: [],
    });
    try {
      const write = (file, text) => {
        fs.mkdirSync(path.dirname(path.join(closedDir, file)), { recursive: true });
        fs.writeFileSync(path.join(closedDir, file), text);
      };
      write('results-ubuntu-latest/suite/results.json', JSON.stringify({ suite: 'suite', files: [{ path: 'test/test-a.js', success: true, skipped: [] }] }));
      write('results-macos-latest/suite/results.json', JSON.stringify({ suite: 'suite', files: [{ path: 'test/test-a.js', success: true, skipped: [] }] }));
      write('results-macos-latest/integration/results.json', '{"suite": "integration", "files": [');
      const closed = await comment(closedDir, { PR: '', GH_TOKEN: 'x', GITHUB_API_URL: closedApi.url, TESTS: '' });
      assert.strictEqual(closed.code, 0, closed.stderr);
      assert.ok(closed.stdout.includes('| Linux | ❌ 1 of 2 files passed; unit (ubuntu-latest): “Tests with coverage” failed |'),
        `a failed job is never ✅, whatever results it left:\n${closed.stdout}`);
      assert.ok(closed.stdout.includes('| macOS | ❌ 1 of 2 files passed; integration: results unreadable |'), 'an unreadable results.json is a failed part, said plainly');
    } finally {
      closedApi.server.close();
      fs.rmSync(closedDir, { recursive: true, force: true });
    }
    console.log('✓ fail closed: a failed job with passing results, and unreadable results, make the row ❌');

    // The first run on a PR: a new comment, with the run's minutes and artifact links
    const first = await fakeGitHub({});
    const posted = await comment(dir, { PR: '7', GH_TOKEN: 'x', GITHUB_API_URL: first.url, TESTS: '' });
    first.server.close();
    assert.strictEqual(posted.code, 0, posted.stderr);
    assert.deepStrictEqual(first.written.map(({ method, url }) => `${method} ${url}`), ['POST /repos/o/r/issues/7/comments']);
    const body = first.written[0].body;
    assert.ok(body.includes(LINUX_ROW), `the Linux row:\n${body}`);
    assert.ok(body.includes('| Linux | 75 % | 50 % | 75 % | [coverage-ubuntu-latest](https://github.com/o/r/actions/runs/42/artifacts/5)'
      + ' | [results-ubuntu-latest](https://github.com/o/r/actions/runs/42/artifacts/6) |'), 'the coverage row and its links');
    assert.ok(body.includes('| `src/tools` | 75 % (30/40) |'), 'the lines by area');
    assert.strictEqual(posted.stdout, body, 'the job summary is the comment, once');
    console.log('✓ the first run: a new comment, with its minutes and artifact links');

    // The next run: the earlier comment edited, Windows' row kept
    const windows = { sha: OLDER, ran: 'everything', minutes: 20, tests: { files: 2, passed: 2, skipped: 0, failed: [] }, coverage: null, areas: [], links: {} };
    const earlier = renderComment({ headSha: OLDER, platforms: { windows } });
    const second = await fakeGitHub({ comments: [{ id: 9, user: { login: 'someone' }, body: `${MARKER}\nnot ours` }, { id: 11, user: { login: 'github-actions[bot]' }, body: earlier }] });
    const edited = await comment(dir, { PR: '7', GH_TOKEN: 'x', GITHUB_API_URL: second.url, TESTS: '' });
    second.server.close();
    assert.deepStrictEqual(second.written.map(({ method, url }) => `${method} ${url}`), ['PATCH /repos/o/r/issues/comments/11'], 'its own comment, not someone else\'s');
    assert.deepStrictEqual(Object.keys(dataOf(second.written[0].body)), ['linux', 'windows']);
    assert.ok(second.written[0].body.includes('| Windows | ✅ 2 of 2 files passed | `everything` | 20 | `fffffff` |'), 'Windows didn\'t run: its row stays');
    assert.strictEqual(edited.code, 0, edited.stderr);
    console.log('✓ the next run: the comment edited, the other platforms\' rows kept');

    // A re-run of an older commit leaves the comment alone
    const moved = await fakeGitHub({ prHead: OLDER });
    const stale = await comment(dir, { PR: '7', GH_TOKEN: 'x', GITHUB_API_URL: moved.url, TESTS: '' });
    moved.server.close();
    assert.deepStrictEqual(moved.written, [], 'nothing written');
    assert.ok(stale.stderr.includes('the PR comment stays as it is') && stale.stdout.includes(LINUX_ROW), stale.stderr);
    console.log('✓ a run of a commit the PR has moved past writes nothing');

    // A token that may not write (a PR from a fork): the summary still has the comment, once
    const readOnly = await fakeGitHub({ refuseWrites: true });
    const refused = await comment(dir, { PR: '7', GH_TOKEN: 'x', GITHUB_API_URL: readOnly.url, TESTS: 'files:test/test-a.js' });
    readOnly.server.close();
    assert.strictEqual(refused.code, 0, 'a comment it may not write fails nothing');
    assert.ok(refused.stderr.includes('wasn\'t written'), refused.stderr);
    assert.strictEqual(refused.stdout.split(MARKER).length - 1, 1, 'the comment once in the summary');
    assert.ok(refused.stdout.includes('| `files:test/test-a.js` |'), 'Ran is the TESTS the run had');
    console.log('✓ a token that may not write: the comment in the summary, once');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

runIfMain(import.meta.url, run);
