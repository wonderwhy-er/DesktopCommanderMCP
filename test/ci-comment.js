/**
 * CI's comment on the PR (helpers/ci-platforms.js): a heading with the commit, a
 * results table with a row per platform, a coverage table, and the lines by area,
 * collapsed. A run replaces its own platforms' rows and keeps the others' last
 * results. Prints the comment, for the job summary.
 *
 *   node test/ci-comment.js <folder with the downloaded artifacts>
 *
 * Reads, per platform: results-<os>/<part>/results.json (each runner's JSON; DC's
 * parts are suite, repro and integration) and coverage-<os>/coverage-summary.json
 * (c8's json-summary), whose lines also go into a table per area of src/
 * (test/coverage-areas.js). With all three platforms' coverage-<os>/coverage-final.json
 * in this run, a Combined row and column: the three together, where the 100 %
 * target is (test/combined-coverage.js). With fewer, or one that can't be read,
 * the row has no figure and says why.
 * Environment (GitHub Actions sets the first three): GITHUB_REPOSITORY,
 * GITHUB_SERVER_URL, GITHUB_API_URL; GH_TOKEN, RUN_ID, HEAD_SHA, PR (the number;
 * without it nothing is posted), TESTS (an on-demand run's tests value; empty,
 * the default, is everything a push or label run runs, shown as "everything"), and
 * TESTS_FROM (a cross-test's: the commit whose tests ran on HEAD_SHA's code, named
 * in the heading).
 * A part that didn't run says why in its results.json (notRun), and the platform's
 * Tests cell carries it; the cell also counts the tests the runners left out by
 * test/excluded.txt (results.json's excluded).
 */
import fs from 'fs';
import path from 'path';
import { MARKER, mergeComment, PLATFORMS, platformJobs, platformMinutes, renderComment, resultsArtifactOf } from './helpers/ci-platforms.js';
import { combineCoverage, readFinals } from './combined-coverage.js';
import { coverageByArea } from './coverage-areas.js';
import { githubApi } from './helpers/github-api.js';

const folder = process.argv[2] ?? 'ci';
const { GITHUB_REPOSITORY: repo, GH_TOKEN: token, RUN_ID: runId, PR: pr, HEAD_SHA: headSha, TESTS_FROM: testsFrom } = process.env;
// What the run tested: empty for everything a push or label run runs, and when the event has no tests input
const ranTests = process.env.TESTS || 'everything';
const server = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
const api = process.env.GITHUB_API_URL ?? 'https://api.github.com';
const runUrl = `${server}/${repo}/actions/runs/${runId}`;

const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined);
const github = githubApi({ api, token });

/** Every page of a list endpoint, e.g. a run's jobs or a PR's comments */
async function githubList(url, key) {
  const items = [];
  for (let page = 1; ; page++) {
    const data = await github('GET', `${url}${url.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const list = key ? data[key] : data;
    items.push(...list);
    if (list.length < 100) return items;
  }
}

// How the comment names a part in a note about it
const PART_NAMES = { suite: 'Suite', repro: 'Repro', integration: 'Integration', docker: 'Docker' };

/**
 * One platform's results from its runners' JSON: files passed of how many, skipped
 * checks, failed files, the tests excluded, and a note for each part that didn't
 * run, with its reason. It fails closed: a results.json that can't be read is a
 * failed part, and a finished job of the platform (`own`) that isn't a success
 * while its results show no failure counts as a failed file, with a note naming
 * the job (or a timed job's test) and its failed step. That's a timed job that
 * stopped before its tests ran, or a part that crashed before writing its results.
 */
function testResults(os, own) {
  // Its one artifact, or with tests=timed one per timed job (results-<runner>-timed-<test>)
  const dirs = (fs.existsSync(folder) ? fs.readdirSync(folder) : [])
    .filter((name) => name === `results-${os}` || name.startsWith(`results-${os}-`))
    .map((name) => path.join(folder, name));
  const parts = [];
  const unreadable = [];
  for (const dir of dirs) {
    for (const part of fs.readdirSync(dir)) {
      const file = path.join(dir, part, 'results.json');
      if (!fs.existsSync(file)) continue;
      let data;
      try {
        data = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        data = undefined;
      }
      if (Array.isArray(data?.files)) parts.push({ ...data, artifact: path.basename(dir) });
      else unreadable.push({ part, artifact: path.basename(dir) });
    }
  }
  if (parts.length === 0 && unreadable.length === 0) return undefined;
  const files = parts.flatMap((part) => part.files);
  const showsFailure = (artifact) => unreadable.some((item) => item.artifact === artifact)
    || parts.some((part) => part.artifact === artifact && part.files.some((file) => !file.success));
  const stopped = own
    .filter((job) => job.completed_at && job.conclusion !== 'success')
    .map((job) => ({ job, ...resultsArtifactOf(job, os) }))
    .filter(({ artifact }) => !fs.existsSync(path.join(folder, artifact)) || !showsFailure(artifact))
    .map(({ job, test }) => ({
      name: test ?? job.name,
      step: job.steps?.find((item) => item.conclusion === 'failure')?.name ?? job.conclusion ?? 'the job',
    }));
  return {
    files: files.length + unreadable.length + stopped.length,
    passed: files.filter((file) => file.success).length,
    skipped: files.reduce((count, file) => count + (file.skipped?.length ?? 0), 0),
    failed: [
      ...files.filter((file) => !file.success).map((file) => file.path),
      ...unreadable.map(({ part }) => part),
      ...stopped.map(({ name }) => name),
    ],
    excluded: parts.reduce((total, part) => total + (part.excluded?.length ?? 0), 0),
    notes: [
      ...parts.filter((part) => part.notRun).map((part) => `${PART_NAMES[part.suite] ?? part.suite}: ${part.notRun}`),
      ...unreadable.map(({ part }) => `${part}: results unreadable`),
      ...stopped.map(({ name, step }) => `${name}: “${step}” failed`),
    ],
  };
}

const pair = (metric) => [metric.covered, metric.total];
/** A coverage summary as the comment keeps it: the totals, and the lines by area */
const coverageOf = ({ total, ...files }) => ({
  coverage: { lines: pair(total.lines), branches: pair(total.branches), functions: pair(total.functions) },
  areas: coverageByArea({ total, ...files }).map(({ area, lines }) => [area, lines.covered, lines.total]),
});

/**
 * The three platforms combined from this run's own reports; undefined without
 * all three, { missing } when one can't be read
 */
function combinedCoverage() {
  const files = PLATFORMS.map(({ os }) => path.join(folder, `coverage-${os}`, 'coverage-final.json'));
  if (!files.every((file) => fs.existsSync(file))) return undefined;
  let finals;
  try {
    finals = readFinals(files);
  } catch (error) {
    const unreadable = files.find((file) => error.message.includes(file));
    return { missing: `${path.basename(path.dirname(unreadable ?? files[0]))} can't be read` };
  }
  return coverageOf(combineCoverage(finals));
}

async function main() {
  const jobs = token && runId ? await githubList(`/repos/${repo}/actions/runs/${runId}/jobs`, 'jobs') : [];
  const artifacts = token && runId ? await githubList(`/repos/${repo}/actions/runs/${runId}/artifacts`, 'artifacts') : [];

  // The results of each platform this run ran
  const data = {};
  for (const { name, os } of PLATFORMS) {
    const own = platformJobs(jobs, os);
    const tests = testResults(os, own);
    if (own.length === 0 && !tests) continue;
    const summary = readJson(path.join(folder, `coverage-${os}`, 'coverage-summary.json'));
    const artifact = (kind) => {
      const found = artifacts.find((item) => item.name === `${kind}-${os}`);
      if (found) return `${runUrl}/artifacts/${found.id}`;
      // A timed run's results are an artifact per job: the run's artifacts list
      return artifacts.some((item) => item.name.startsWith(`${kind}-${os}-`)) ? `${runUrl}#artifacts` : undefined;
    };
    data[name] = {
      sha: headSha ?? '',
      ran: ranTests,
      // Its test jobs' minutes, first start to last end, null while one is still going (jobs the run lists, not this one)
      minutes: platformMinutes(jobs, os),
      tests: tests ?? null,
      // The jobs stopped before the runners wrote anything: at which step
      stoppedAt: tests ? undefined : own.flatMap((item) => item.steps ?? []).find((item) => item.conclusion === 'failure')?.name,
      ...(summary ? coverageOf(summary) : { coverage: null, areas: [] }),
      links: { run: runUrl, coverage: artifact('coverage'), results: artifact('results') },
    };
  }
  const combined = combinedCoverage();

  // The job summary gets the comment once, whether or not it could be posted
  let body = renderComment({ headSha, testsFrom, platforms: data, combined });
  try {
    if (!pr || !token) return;
    // A re-run of an older run must not replace the newest commit's results
    const prHead = (await github('GET', `/repos/${repo}/pulls/${pr}`)).head?.sha;
    if (headSha && prHead && prHead !== headSha) {
      console.error(`\nThe PR's head is ${prHead.slice(0, 7)} now, not ${headSha.slice(0, 7)}: the PR comment stays as it is.`);
      return;
    }
    const comments = await githubList(`/repos/${repo}/issues/${pr}/comments`);
    const mine = comments.find((comment) => comment.user?.login === 'github-actions[bot]' && comment.body?.startsWith(MARKER));
    body = mergeComment({ headSha, data, earlier: mine?.body, combined });
    if (mine) await github('PATCH', `/repos/${repo}/issues/comments/${mine.id}`, { body });
    else await github('POST', `/repos/${repo}/issues/${pr}/comments`, { body });
  } catch (error) {
    // A PR from a fork gets a read-only token: the job summary still has the comment
    console.error(`\nThe PR comment wasn't written: ${error.message}`);
  } finally {
    process.stdout.write(body);
  }
}

await main();
