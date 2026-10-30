/**
 * CI's platforms (helpers/ci-platforms.js): which platforms a run tests, from
 * the event GitHub Actions passes, and the PR comment.
 * - Only the platforms whose label the PR has run: `linux`, `windows`, `macos`.
 *   With none of them, nothing runs. A push runs every labelled platform; adding
 *   one of those labels runs just its platform; another label, or removing one,
 *   runs nothing.
 * - A comment line `/test <platforms>` runs those (`linux`, `windows`, `macos`).
 *   The workflow runs it from main, so its test job checks out the PR's head by
 *   SHA, with a read-only token, no secret and no npm cache, and the comment job
 *   runs main's script.
 * - Only the maintainers start a run: PRs they opened, comments they wrote. One
 *   list, MAINTAINERS, for both workflows (tests.yml, review.yml); no workflow
 *   names a login.
 * - The AI review (review.yml): the label `review` on a push, adding it, a
 *   `/review` line, or an on-demand run.
 * - The PR comment has no prose: a heading with the commit, a results table with
 *   a row per platform, the coverage tables and the links. A run replaces its own
 *   platforms' rows and keeps the others' last results, and the workflow's
 *   comment jobs wait their turn, every one of them.
 * Pure functions and the workflow file's text: it starts nothing.
 */
import assert from 'assert';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  commandPlatforms, commandReview, dataOf, isMaintainer, MAINTAINERS, MARKER, matrixFor, mergeComment, minutesOf, osOf, platformMinutes, platformsFor, plain,
  renderComment, reviewFor, timedNamesIn,
} from './helpers/ci-platforms.js';
import { ROOT } from './helpers/node-test-runner.js';
import { runIfMain } from './helpers/run-if-main.js';
import { createTempDir } from './helpers/test-env.js';
import { blockUnder, jobLines, readWorkflow } from './helpers/workflow-file.js';

// Events as GitHub sends them: a maintainer opened the PR or wrote the comment, unless a login is given
const push = (action, labels = [], login = 'mihailt') => ({ action, pull_request: { user: { login }, labels: labels.map((name) => ({ name })) } });
const labeled = (name, labels = [name], login = 'mihailt') => ({
  action: 'labeled', label: { name }, pull_request: { user: { login }, labels: labels.map((label) => ({ name: label })) },
});
const comment = (body, onPullRequest = true, login = 'mihailt') => ({
  action: 'created', issue: onPullRequest ? { pull_request: {}, user: { login: 'mihailt' } } : {}, comment: { body, user: { login } },
});
// review.yml's on-demand run
const reviewDispatch = (login = 'mihailt') => ({ inputs: { commit: 'a'.repeat(40), base: 'main' }, sender: { login } });
const WORKFLOWS = ['tests.yml', 'review.yml'];

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
/** One platform's results as ci-comment.js gathers them */
const results = (sha, more = {}) => ({
  sha,
  ran: 'everything',
  minutes: 12,
  tests: { files: 3, passed: 3, skipped: 0, failed: [] },
  coverage: { lines: [50, 100], branches: [3, 4], functions: [9, 10] },
  areas: [['src/tools', 40, 80], ['src/ui', 10, 20]],
  links: {
    run: 'https://github.com/o/r/actions/runs/1',
    coverage: 'https://github.com/o/r/actions/runs/1/artifacts/3',
    results: 'https://github.com/o/r/actions/runs/1/artifacts/4',
  },
  ...more,
});
/** A line of the comment that isn't a heading, a table row, a collapsible or hidden data */
const prose = (body) => body.split('\n').filter((line) => !/^(|## .*|\|.*|<!--.*-->|<details><summary>[^<]*<\/summary>|<\/details>)$/.test(line));

export default async function run() {
  // A push: every labelled platform, and nothing without a label
  for (const action of ['opened', 'synchronize', 'reopened']) {
    assert.deepStrictEqual(platformsFor('pull_request', push(action)), [], `${action}, no label: nothing runs, not even Linux`);
  }
  assert.deepStrictEqual(platformsFor('pull_request', push('synchronize', ['linux'])), ['linux']);
  assert.deepStrictEqual(platformsFor('pull_request', push('synchronize', ['windows'])), ['windows'], 'Windows alone: no Linux');
  assert.deepStrictEqual(platformsFor('pull_request', push('synchronize', ['macos', 'bug'])), ['macos'], 'another label adds nothing');
  assert.deepStrictEqual(platformsFor('pull_request', push('synchronize', ['macos', 'windows', 'linux'])), ['linux', 'windows', 'macos'],
    'every labelled platform, in order');
  assert.deepStrictEqual(platformsFor('pull_request', push('synchronize', ['all-platforms'])), [], 'all-platforms is no label of ours');
  console.log('✓ a push: every labelled platform, and nothing without a label');

  // Adding a label: just its platform
  assert.deepStrictEqual(platformsFor('pull_request', labeled('linux')), ['linux']);
  assert.deepStrictEqual(platformsFor('pull_request', labeled('windows')), ['windows']);
  assert.deepStrictEqual(platformsFor('pull_request', labeled('macos', ['linux', 'windows', 'macos'])), ['macos'], 'not the labels the PR already had');
  assert.deepStrictEqual(platformsFor('pull_request', labeled('all-platforms')), [], 'all-platforms is no label of ours');
  assert.deepStrictEqual(platformsFor('pull_request', labeled('bug')), [], 'another label runs nothing');
  assert.deepStrictEqual(platformsFor('pull_request', { ...push('unlabeled', ['linux']), label: { name: 'windows' } }), [],
    'removing a label runs nothing, though the PR still has linux');
  assert.deepStrictEqual(platformsFor('push', {}), [], 'only pull_request, issue_comment and workflow_dispatch events run');
  console.log('✓ adding a label runs just its platform; another label, or removing one, runs nothing');

  // A comment: every line that starts with /test
  assert.deepStrictEqual(platformsFor('issue_comment', comment('/test windows macos')), ['windows', 'macos']);
  assert.deepStrictEqual(platformsFor('issue_comment', comment('/test linux')), ['linux']);
  assert.deepStrictEqual(platformsFor('issue_comment', comment('Looks good.\r\n/test MacOS, Windows\n/test macos')), ['windows', 'macos'],
    'any line, any case, commas, each platform once');
  assert.deepStrictEqual(commandPlatforms('/test linux|windows'), ['linux', 'windows']);
  assert.deepStrictEqual(commandPlatforms('  /test windows'), ['windows'], 'leading spaces');
  for (const body of ['/test', '/test all-platforms', '/test everything', 'please /test windows', '/testing windows', '', undefined]) {
    assert.deepStrictEqual(commandPlatforms(body), [], `nothing for ${JSON.stringify(body)}`);
  }
  assert.deepStrictEqual(platformsFor('issue_comment', comment('/test windows', false)), [], 'a comment on an issue, not a PR');
  assert.deepStrictEqual(platformsFor('issue_comment', { ...comment('/test windows'), action: 'edited' }), [], 'an edited comment runs nothing');
  console.log('✓ a /test comment runs the platforms it names');

  // An on-demand run (gh workflow run tests.yml -f commit=… -f platforms=… -f tests=…)
  const dispatch = (platforms, tests = '') => platformsFor('workflow_dispatch', { inputs: { commit: 'abc1234', platforms, tests } });
  assert.deepStrictEqual(dispatch('linux, windows'), ['linux', 'windows']);
  // One platform with an s in its name, alone, so the Linux fallback can't hide a wrong split
  assert.deepStrictEqual(dispatch('windows'), ['windows']);
  assert.deepStrictEqual(dispatch('macos'), ['macos']);
  assert.deepStrictEqual(dispatch('macos,bsd'), ['macos'], 'another word is no platform');
  assert.deepStrictEqual(dispatch(''), ['linux'], 'no platforms given: Linux');
  assert.deepStrictEqual(dispatch('linux,windows,macos', 'docker'), ['linux'], 'docker runs on Linux only');
  assert.deepStrictEqual(platformsFor('workflow_dispatch', {}), ['linux'], 'no inputs at all: Linux');
  console.log('✓ an on-demand run: the platforms it names, Linux by default, docker on Linux only');

  // Who starts a run: the maintainers, one list for both workflows
  assert.deepStrictEqual(MAINTAINERS, ['wonderwhy-er', 'mihailt', 'ds-dcmpc', 'edgarsskore', 'Rkrizanovskis', 'serg33v']);
  assert.ok(isMaintainer('MihailT') && isMaintainer('serg33v'), 'logins in any case, as GitHub\'s contains() compares them');
  for (const login of ['someone', '', undefined, 'mihailt2', 'github-actions[bot]']) {
    assert.ok(!isMaintainer(login), `${JSON.stringify(login)} is no maintainer`);
  }
  assert.deepStrictEqual(platformsFor('pull_request', push('synchronize', ['linux'], 'someone')), [], 'a PR someone else opened runs nothing');
  assert.deepStrictEqual(platformsFor('pull_request', labeled('windows', ['windows'], 'someone')), [], 'nor does a label added to it');
  assert.deepStrictEqual(platformsFor('issue_comment', comment('/test linux', true, 'someone')), [],
    'a /test comment someone else wrote on a maintainer\'s PR runs nothing');
  for (const file of WORKFLOWS) {
    const text = readWorkflow(file);
    for (const login of MAINTAINERS) assert.ok(!text.includes(login), `${file} names no login (${login}): the list is MAINTAINERS`);
  }
  console.log('✓ only the maintainers start a run, from one list');

  // The AI review: the label review on a push, adding it, a /review line, or an on-demand run
  for (const action of ['opened', 'synchronize', 'reopened']) {
    assert.strictEqual(reviewFor('pull_request', push(action, ['linux', 'review'])), true, `${action}, labelled review: reviewed`);
    assert.strictEqual(reviewFor('pull_request', push(action, ['linux'])), false, `${action}, no review label: not reviewed`);
  }
  assert.strictEqual(reviewFor('pull_request', labeled('review')), true, 'adding the label reviews at once');
  assert.strictEqual(reviewFor('pull_request', labeled('linux', ['linux', 'review'])), false, 'another label added: no second review');
  assert.strictEqual(reviewFor('pull_request', { ...push('unlabeled', ['linux']), label: { name: 'review' } }), false, 'removing it: nothing');
  assert.strictEqual(reviewFor('pull_request', push('synchronize', ['review'], 'someone')), false, 'a PR someone else opened: not reviewed');
  assert.strictEqual(reviewFor('issue_comment', comment('/review')), true);
  assert.strictEqual(reviewFor('issue_comment', comment('Thanks.\r\n  /REVIEW  \n')), true, 'any line, any case');
  for (const body of ['/reviewer', 'please /review', '/review now', '/test linux', '', undefined]) {
    assert.strictEqual(commandReview(body), false, `no review for ${JSON.stringify(body)}`);
  }
  assert.strictEqual(reviewFor('issue_comment', comment('/review', false)), false, 'a comment on an issue, not a PR');
  assert.strictEqual(reviewFor('issue_comment', { ...comment('/review'), action: 'edited' }), false, 'an edited comment: nothing');
  assert.strictEqual(reviewFor('issue_comment', comment('/review', true, 'someone')), false, 'someone else\'s /review: nothing');
  assert.strictEqual(reviewFor('workflow_dispatch', reviewDispatch()), true, 'an on-demand run by a maintainer');
  assert.strictEqual(reviewFor('workflow_dispatch', reviewDispatch('someone')), false, 'an on-demand run by anyone else: nothing');
  assert.strictEqual(reviewFor('push', {}), false);
  console.log('✓ the review: its label on a push or added, a /review line, an on-demand run; maintainers only');

  assert.deepStrictEqual(osOf(['macos', 'linux']), ['ubuntu-latest', 'macos-latest'], 'runner images, in order');
  assert.deepStrictEqual(osOf([]), []);
  console.log('✓ the matrix\'s runner images');

  // tests=timed: one job per timed test and platform, named in test/timed.txt at the commit
  assert.deepStrictEqual(timedNamesIn('# a header\n\ntest-a.js  # why\r\nrepro/test-b.js  # why too\n   # an indented comment\n'), ['test-a.js', 'repro/test-b.js']);
  const twoOs = ['ubuntu-latest', 'windows-latest'];
  assert.deepStrictEqual(matrixFor(twoOs, { tests: '' }), { os: twoOs }, 'a run of everything: one job per platform, as before');
  assert.deepStrictEqual(matrixFor(twoOs, { tests: 'test' }), { os: twoOs });
  assert.deepStrictEqual(matrixFor(twoOs, { tests: 'timed', timed: ['test-a.js', 'repro/test-b.js'] }), { include: [
    { os: 'ubuntu-latest', timed: 'test-a.js', id: 'timed-test-a.js' },
    { os: 'ubuntu-latest', timed: 'repro/test-b.js', id: 'timed-repro-test-b.js' },
    { os: 'windows-latest', timed: 'test-a.js', id: 'timed-test-a.js' },
    { os: 'windows-latest', timed: 'repro/test-b.js', id: 'timed-repro-test-b.js' },
  ] }, 'timed: a job per test and platform, its artifact named after its test (no / in an artifact name), so the comment can match job and artifact');
  assert.deepStrictEqual(matrixFor(twoOs, { tests: 'timed', timed: [] }), { os: [] }, 'no timed test: no job');
  console.log('✓ the test jobs\' matrix: a job per platform, or with tests=timed a job per timed test and platform');

  // A platform's minutes: from its first job's start to its last job's end; null while one still runs
  const job = (name, started, completed) => ({ name, started_at: started, completed_at: completed });
  const timedJobs = [
    job('unit (ubuntu-latest, test-a.js)', '2026-10-30T04:00:00Z', '2026-10-30T04:03:00Z'),
    job('unit (ubuntu-latest, repro/test-b.js)', '2026-10-30T04:01:00Z', '2026-10-30T04:07:10Z'),
    job('unit (windows-latest, test-a.js)', '2026-10-30T04:00:00Z', null),
    job('comment', '2026-10-30T04:08:00Z', null),
  ];
  assert.strictEqual(platformMinutes(timedJobs, 'ubuntu-latest'), 7, 'its jobs together: 04:00 to 04:07:10');
  assert.strictEqual(platformMinutes(timedJobs, 'windows-latest'), null, 'a job still running');
  assert.strictEqual(platformMinutes(timedJobs, 'macos-latest'), undefined, 'no job of that platform');
  assert.strictEqual(platformMinutes([job('unit (ubuntu-latest)', '2026-10-30T04:00:00Z', '2026-10-30T04:12:29Z')], 'ubuntu-latest'), 12, 'one job, as before');
  console.log('✓ a platform\'s minutes span all its jobs');

  // The platforms job's CLI: the event GitHub passes in, its outputs in GITHUB_OUTPUT
  let cli;
  const cliDir = createTempDir('dc-ci-platforms-');
  try {
    cli = (eventName, event, env = {}) => {
      const eventPath = path.join(cliDir, `${eventName}.json`);
      const outputPath = path.join(cliDir, `${eventName}.output`);
      fs.writeFileSync(eventPath, JSON.stringify(event));
      fs.writeFileSync(outputPath, 'earlier=line\n');
      const result = spawnSync(process.execPath, [path.join(ROOT, 'test', 'ci-platforms.js')], {
        encoding: 'utf8',
        env: { ...process.env, GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath, ...env },
      });
      assert.strictEqual(result.status, 0, result.stderr);
      return fs.readFileSync(outputPath, 'utf8');
    };
    assert.strictEqual(cli('pull_request', push('synchronize', ['macos', 'linux'])),
      'earlier=line\nplatforms=["linux","macos"]\nos=["ubuntu-latest","macos-latest"]\nmatrix={"os":["ubuntu-latest","macos-latest"]}\n',
      'appended to what GITHUB_OUTPUT had');
    assert.strictEqual(cli('issue_comment', comment('/test windows')), 'earlier=line\nplatforms=["windows"]\nos=["windows-latest"]\nmatrix={"os":["windows-latest"]}\n');
    assert.strictEqual(cli('pull_request', push('synchronize')), 'earlier=line\nplatforms=[]\nos=[]\nmatrix={"os":[]}\n', 'no label: an empty matrix');
    assert.strictEqual(cli('issue_comment', comment('/test windows', true, 'someone')), 'earlier=line\nplatforms=[]\nos=[]\nmatrix={"os":[]}\n',
      'a commenter who isn\'t on the list: an empty matrix');
    // tests=timed: the timed list the workflow read at the commit (TIMED_LIST), a job per test and platform
    const timedList = path.join(cliDir, 'timed.txt');
    fs.writeFileSync(timedList, '# header\ntest-a.js  # why\nrepro/test-b.js  # why too\n');
    const timedOutput = cli('workflow_dispatch', { inputs: { commit: 'abc1234', platforms: 'linux', tests: 'timed' } }, { TIMED_LIST: timedList });
    assert.ok(timedOutput.endsWith('\nmatrix={"include":[{"os":"ubuntu-latest","timed":"test-a.js","id":"timed-test-a.js"},{"os":"ubuntu-latest","timed":"repro/test-b.js","id":"timed-repro-test-b.js"}]}\n'),
      timedOutput);
    // Fail closed: tests=timed with no timed test at the commit fails the platforms job, rather than a green run with no job
    fs.writeFileSync(timedList, '# header only\n\n');
    const noTimed = spawnSync(process.execPath, [path.join(ROOT, 'test', 'ci-platforms.js')], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_EVENT_PATH: path.join(cliDir, 'workflow_dispatch.json'),
        GITHUB_OUTPUT: path.join(cliDir, 'none.output'), TIMED_LIST: timedList },
    });
    assert.ok(noTimed.status !== 0 && /tests=timed: test\/timed\.txt names no test/.test(noTimed.stderr), `${noTimed.status}: ${noTimed.stderr}`);
  } finally {
    fs.rmSync(cliDir, { recursive: true, force: true });
  }
  console.log('✓ the platforms job\'s CLI writes the matrix to GITHUB_OUTPUT');

  // The PR comment: no prose; a row per platform; a run replaces its platforms' rows and keeps the others'
  const first = mergeComment({ headSha: SHA_A, data: { linux: results(SHA_A), windows: results(SHA_A) } });
  assert.ok(first.startsWith(`${MARKER}\n## Tests and coverage for \`aaaaaaa\``), 'one heading, with the commit');
  assert.deepStrictEqual(prose(first), [], 'no prose: headings, tables, the collapsible and hidden data only');
  assert.ok(first.includes('| Platform | Tests | Ran | Minutes | Commit | Run |\n|---|---|---|---|---|---|\n'), 'the results table, as agreed');
  assert.ok(!/system/i.test(first), 'no "System"');
  assert.ok(first.includes('| Linux | ✅ 3 of 3 files passed | `everything` | 12 | `aaaaaaa` | [run](https://github.com/o/r/actions/runs/1) |'));
  assert.ok(first.includes('| Platform | Lines | Branches | Functions | Report (HTML, lcov, JSON, Cobertura) | Results (JUnit, JSON, TAP) |'), 'the coverage table');
  assert.ok(first.includes('| Linux | 50 % | 75 % | 90 % | [coverage-ubuntu-latest](https://github.com/o/r/actions/runs/1/artifacts/3)'
    + ' | [results-ubuntu-latest](https://github.com/o/r/actions/runs/1/artifacts/4) |'), 'a coverage row, with its report and results');
  assert.ok(first.includes('<details><summary>Lines by area</summary>\n\n| Area | Linux | Windows |'), 'lines by area, collapsed, a column per platform');
  assert.ok(first.includes('| `src/ui` | 50 % (10/20) | 50 % (10/20) |\n| **total** | 50 % (50/100) | 50 % (50/100) |'),
    'src/ui is an ordinary area; one total, in the same table');
  assert.ok(!first.includes('total without'), 'no area is set apart');
  assert.ok(renderComment({ headSha: SHA_A, platforms: { linux: results(SHA_A, { coverage: { lines: [4621, 10000], branches: [1, 3], functions: [0, 0] } }) } })
    .includes('| Linux | 46.21 % | 33.33 % | 100 % |'), 'percentages to two decimals; nothing to cover is 100 %');
  assert.ok(renderComment({ headSha: SHA_A, platforms: { linux: results(SHA_A, { coverage: { lines: [19999, 20000], branches: [2, 3], functions: [1, 1] } }) } })
    .includes('| Linux | 99.99 % | 66.66 % | 100 % |'), 'cut, not rounded, to two decimals, as c8\'s own report shows them');
  assert.deepStrictEqual(Object.keys(dataOf(first)), ['linux', 'windows'], 'each platform\'s results are kept in the comment');

  const row = (label, sha) => `| ${label} | ✅ 3 of 3 files passed | \`everything\` | 12 | \`${sha.slice(0, 7)}\` |`;
  const second = mergeComment({ headSha: SHA_B, data: { linux: results(SHA_B) }, earlier: first });
  assert.ok(second.includes('## Tests and coverage for `bbbbbbb`'));
  assert.ok(second.includes(row('Linux', SHA_B)) && !second.includes(row('Linux', SHA_A)), 'Linux ran: its row is new');
  assert.ok(second.includes(row('Windows', SHA_A)), 'Windows didn\'t run: its last results stay, with their commit');
  const third = mergeComment({ headSha: SHA_C, data: { macos: results(SHA_C) }, earlier: second });
  assert.deepStrictEqual(Object.keys(dataOf(third)), ['linux', 'windows', 'macos']);
  assert.ok(third.indexOf(row('Linux', SHA_B)) < third.indexOf(row('Windows', SHA_A)) && third.indexOf(row('Windows', SHA_A)) < third.indexOf(row('macOS', SHA_C)),
    'Linux, Windows, macOS, whichever ran last');
  const fromOldComment = mergeComment({ headSha: SHA_A, data: { windows: results(SHA_A) }, earlier: `${MARKER}\nan older comment\n| System | Tests |` });
  assert.ok(!fromOldComment.includes('older comment') && !fromOldComment.includes('System'), 'an older comment\'s text goes');
  assert.deepStrictEqual(Object.keys(dataOf(fromOldComment)), ['windows']);
  console.log('✓ the PR comment: no prose, a row per platform, and a platform\'s last results kept');

  // A failed run, and one that stopped before its tests wrote anything
  const failed = renderComment({ headSha: SHA_A, platforms: { linux: results(SHA_A, { tests: { files: 3, passed: 2, skipped: 0, failed: ['test/test-x.js'] } }) } });
  assert.ok(failed.includes('| Linux | ❌ 2 of 3 files passed | `everything` | 12 | `aaaaaaa` |'));
  const stopped = renderComment({ headSha: SHA_A, platforms: { windows: { sha: SHA_A, tests: null, stoppedAt: 'Install', coverage: null, areas: [], links: {} } } });
  assert.ok(stopped.includes('| Windows | ❌ no results: “Install” failed | – | – | `aaaaaaa` | – |') && stopped.includes('| Windows | – | – | – | – | – |'),
    'a row kept from before Ran and Minutes shows –');
  assert.ok(!stopped.includes('Lines by area'), 'no area table without coverage');
  assert.deepStrictEqual(prose(stopped), []);
  console.log('✓ a failed run, and one with no results');

  // A part that didn't run (Docker's on macOS) says why, in its platform's Tests cell
  const noted = renderComment({ headSha: SHA_A, platforms: {
    macos: results(SHA_A, { tests: { files: 3, passed: 3, skipped: 0, failed: [], notes: ['Docker: GitHub\'s macOS runner has no Docker'] } }),
  } });
  assert.ok(noted.includes('| macOS | ✅ 3 of 3 files passed; Docker: GitHub\'s macOS runner has no Docker | `everything` |'), 'not a silent skip');
  assert.deepStrictEqual(prose(noted), []);
  // The excluded tests: how many, after the notes, and where they're listed
  const excluded = renderComment({ headSha: SHA_A, platforms: {
    linux: results(SHA_A, { tests: { files: 3, passed: 3, skipped: 0, failed: [], excluded: 2 } }),
    macos: results(SHA_A, { tests: { files: 3, passed: 3, skipped: 0, failed: [], notes: ['Docker: GitHub\'s macOS runner has no Docker'], excluded: 1 } }),
    windows: results(SHA_A, { tests: { files: 3, passed: 3, skipped: 0, failed: [], excluded: 0 } }),
  } });
  assert.ok(excluded.includes('| Linux | ✅ 3 of 3 files passed; 2 excluded (test/excluded.txt) |'), excluded);
  assert.ok(excluded.includes('| macOS | ✅ 3 of 3 files passed; Docker: GitHub\'s macOS runner has no Docker; 1 excluded (test/excluded.txt) |'), excluded);
  assert.ok(excluded.includes('| Windows | ✅ 3 of 3 files passed | `everything` |'), 'none excluded: nothing said');
  console.log('✓ a part that didn\'t run says why, and the excluded tests are counted, in the Tests cell');

  // Fail closed: a run where no test file ran is no pass, and skipped checks show
  const failClosed = renderComment({ headSha: SHA_A, platforms: {
    linux: results(SHA_A, { tests: { files: 0, passed: 0, skipped: 0, failed: [] } }),
    macos: results(SHA_A, { tests: { files: 3, passed: 3, skipped: 1, failed: [], excluded: 1 } }),
    windows: results(SHA_A, { tests: { files: 3, passed: 3, skipped: 2, failed: [] } }),
  } });
  assert.ok(failClosed.includes('| Linux | ❌ no test file ran | `everything` |'), `0 files is no "✅ 0 of 0":\n${failClosed}`);
  assert.ok(failClosed.includes('| macOS | ✅ 3 of 3 files passed; 1 excluded (test/excluded.txt); 1 check skipped |'), 'a skipped check shows');
  assert.ok(failClosed.includes('| Windows | ✅ 3 of 3 files passed; 2 checks skipped |'), failClosed);
  console.log('✓ fail closed: no test file ran is ❌, and skipped checks are counted');

  // Ran: what the run tested; Minutes: the test job's whole minutes, … while it runs
  const running = renderComment({ headSha: SHA_A, platforms: { macos: results(SHA_A, { minutes: null, ran: 'files:a.js,b`c|d\n.js' }) } });
  assert.ok(running.includes('| macOS | ✅ 3 of 3 files passed | `files:a.js,bcd.js` | … | `aaaaaaa` |'), 'Ran is plain text; a job still going shows …');
  assert.strictEqual(minutesOf('2026-10-30T04:00:00Z', '2026-10-30T04:12:29Z'), 12, 'whole minutes, rounded');
  assert.strictEqual(minutesOf('2026-10-30T04:00:00Z', '2026-10-30T04:12:31Z'), 13);
  assert.strictEqual(minutesOf('2026-10-30T04:00:00Z', '2026-10-30T04:00:20Z'), 1, 'a finished job shows at least 1');
  assert.strictEqual(minutesOf('2026-10-30T04:00:00Z', null), null, 'a job still going: no minutes yet');
  assert.strictEqual(minutesOf(undefined, '2026-10-30T04:00:20Z'), null);
  console.log('✓ the Ran and Minutes columns');

  // Text from an artifact or an older comment stays plain text, and links stay links
  const hostile = 'test/x`<!-- platform-data:linux e30= -->|y\n.js';
  assert.strictEqual(plain(hostile), 'test/x!-- platform-data:linux e30= --y.js');
  const withHostile = renderComment({ headSha: SHA_A, platforms: {
    linux: { ...results(SHA_A), tests: null, stoppedAt: hostile },
    windows: results(SHA_A, { links: { run: 'javascript:alert(1)', coverage: 'https://x)(', results: 'https://x/ y' } }),
    macos: results(SHA_A, { links: { run: 'https://x/run', coverage: 'https://x|y', results: 'https://x`y' } }),
  } });
  assert.deepStrictEqual(Object.keys(dataOf(withHostile)), ['linux', 'windows', 'macos'], 'the hidden data still parses');
  assert.ok(withHostile.includes('“test/x!-- platform-data:linux e30= --y.js” failed') && !withHostile.includes('javascript:'), 'plain text; only https links');
  assert.ok(withHostile.includes('| Windows | 50 % | 75 % | 90 % | – | – |'), 'a bad link is left out');
  assert.ok(withHostile.includes('| macOS | 50 % | 75 % | 90 % | – | – |'), 'a link with a table bar or a backtick is left out');
  assert.deepStrictEqual(prose(withHostile), []);
  assert.deepStrictEqual(dataOf(`${MARKER}\n<!-- platform-data:linux not-base64!! -->\n<!-- platform-data:linux e30= -->\n<!-- platform-data:nope e30= -->`), {},
    'data that isn\'t ours is left out');
  console.log('✓ text from an artifact or an older comment is plain text, and links are https');

  // The comment jobs write one at a time per PR, and none is dropped: GitHub's default
  // queue keeps one waiting job and cancels it when a third run's comment job comes
  const workflow = readWorkflow('tests.yml');

  // A PR opened with its labels: GitHub sends opened, then a labeled event for each label. Each platform runs once:
  // opened starts nothing (the labeled events run the platforms), and the review label's event picks no platform
  const prTypes = (/^ {2}pull_request:\n {4}types: \[([^\]]*)\]/m.exec(workflow)?.[1] ?? '').split(',').map((type) => type.trim());
  assert.ok(['synchronize', 'reopened', 'labeled'].every((type) => prTypes.includes(type)), `a push, a reopen and a label still run: ${prTypes}`);
  const openedWith = ['linux', 'windows', 'macos', 'review'];
  const runs = {};
  for (const event of [push('opened', openedWith), ...openedWith.map((label) => labeled(label, openedWith))]) {
    if (!prTypes.includes(event.action)) continue;
    for (const name of platformsFor('pull_request', event)) runs[name] = (runs[name] ?? 0) + 1;
  }
  assert.deepStrictEqual(runs, { linux: 1, windows: 1, macos: 1 }, `a PR opened with its labels runs each platform once: ${JSON.stringify(runs)}`);
  assert.deepStrictEqual(platformsFor('pull_request', push('opened', openedWith)), [], 'opened alone starts no platform: its labeled events do');
  console.log('✓ a PR opened with its labels: each platform once, the review label\'s event none');

  const commentJob = jobLines(workflow, 'comment');
  const concurrency = blockUnder(commentJob, 'concurrency');
  assert.ok(concurrency.some((line) => line.startsWith('group: tests-comment-')), 'one group per PR');
  assert.ok(concurrency.includes('cancel-in-progress: false'), 'a writing comment job finishes');
  assert.ok(concurrency.includes('queue: max'), 'every waiting comment job keeps its place');
  console.log('✓ the comment jobs wait their turn, every one');

  // The workflow's own platform labels (its gate and concurrency groups) are the helper's three
  assert.strictEqual(workflow.split('fromJSON(\'["linux","windows","macos"]\')').length - 1, 2, 'the concurrency group and the gate\'s added label');
  for (const label of ['linux', 'windows', 'macos']) {
    assert.ok(workflow.includes(`contains(github.event.pull_request.labels.*.name, '${label}')`), `a push to a PR labelled ${label} passes the gate`);
  }
  assert.ok(!workflow.includes('all-platforms'), 'no all-platforms label');
  console.log('✓ the workflow knows the same three labels');

  // A comment's run starts from main with the repository's token, and tests the PR's code:
  // only a listed commenter starts it; the test job gets the head by SHA, a read-only token,
  // no secret and no npm cache; the comment job, which can write, runs main's script
  // The gate starts the platforms job for a /test comment; that job's CLI checks the commenter (above)
  const gate = jobLines(workflow, 'platforms').find((line) => line.trim().startsWith('if:'));
  assert.ok(gate.includes("contains(github.event.comment.body, '/test')"), 'a /test comment passes the gate');
  const unit = jobLines(workflow, 'unit');
  assert.ok(!unit.some((line) => line.includes('secrets.')), 'the test job names no secret');
  assert.deepStrictEqual(blockUnder(unit, 'permissions'), ['contents: read'], 'a read-only token');
  assert.ok(unit.some((line) => line.trim() === 'persist-credentials: false'), 'the checkout keeps no token');
  assert.ok(unit.some((line) => line.trim() === "ref: ${{ github.event_name != 'pull_request' && needs.platforms.outputs.sha || '' }}"),
    'a comment\'s or an on-demand run checks out exactly the commit the platforms job read');
  assert.ok(unit.some((line) => line.trim() === "cache: ${{ github.event_name == 'pull_request' && 'npm' || '' }}"),
    'no npm cache on a comment\'s or an on-demand run');
  assert.ok(!commentJob.some((line) => line.trim().startsWith('ref:')), 'the comment job checks out main\'s script, never the PR\'s');

  // An on-demand run's inputs, and how they reach the scripts: only through the environment,
  // never written into a shell command, where a quote in an input would become code
  const dispatchBlock = workflow.split(/\r?\n/);
  const on = dispatchBlock.indexOf('  workflow_dispatch:');
  assert.ok(on > 0, 'the workflow can be started on demand');
  for (const input of ['commit', 'platforms', 'tests']) assert.ok(dispatchBlock.slice(on, on + 20).includes(`      ${input}:`), `the input ${input}`);
  const usesInputs = dispatchBlock.filter((line) => /\binputs\./.test(line));
  assert.ok(usesInputs.length > 0 && usesInputs.every((line) => /^\s+[A-Z_]+: \$\{\{ (github\.event\.)?inputs\.\w+ \}\}$/.test(line)),
    `inputs only as environment variables:\n${usesInputs.join('\n')}`);
  assert.ok(unit.some((line) => line.trim() === 'TESTS: ${{ inputs.tests }}'), 'the test job gets the tests value');
  assert.ok(commentJob.some((line) => line.trim() === 'TESTS: ${{ inputs.tests }}'), 'the comment shows it as Ran');

  // The commit an on-demand run names is checked before anything uses it, and its PR reaches the comment job
  const platformsJob = jobLines(workflow, 'platforms').map((line) => line.trim());
  assert.ok(platformsJob.includes('[[ "$COMMIT" =~ ^[0-9a-fA-F]{7,40}$ ]] || { echo "commit: not a SHA: $COMMIT"; exit 1; }'), 'the commit input must be 7 to 40 hex digits');
  assert.ok(platformsJob.includes('[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "Not a commit SHA: $sha"; exit 1; }'), 'and resolves to a full SHA');
  assert.ok(platformsJob.includes('pr: ${{ steps.head.outputs.pr }}'), 'the platforms job outputs the PR it found');
  assert.ok(commentJob.some((line) => line.trim() === 'PR: ${{ needs.platforms.outputs.pr }}'), 'the comment job writes to that PR');
  assert.ok(commentJob.some((line) => line.trim() === 'group: tests-comment-${{ needs.platforms.outputs.pr }}'), 'and queues with that PR\'s other comment jobs');
  assert.ok(platformsJob.includes('[[ -z "$pr" || "$pr" =~ ^[0-9]+$ ]] || { echo "Not a PR number: $pr"; exit 1; }'), 'the PR found is a number, or none');
  assert.ok(platformsJob.includes(String.raw`pr=$(gh api "repos/$GITHUB_REPOSITORY/commits/$sha/pulls" | jq -r --arg sha "$sha" '[.[] | select(.state == "open" and .head.sha == $sha)][0].number // empty') ;;`),
    'the open PR whose head the commit is, whatever order GitHub lists them in; the SHA passed to jq as data');
  // GitHub's default bash has -e but not pipefail: a failed gh api that writes nothing would leave jq's 0
  const headStep = platformsJob.slice(platformsJob.indexOf('- name: The commit and its PR'));
  assert.strictEqual(headStep[headStep.indexOf('run: |') + 1], 'set -o pipefail', 'the step\'s first line: a failed gh api fails the step, through the pipe too');

  // No `all` value: the tests input is empty by default, which runs what a label run runs
  const lines = workflow.split(/\r?\n/);
  const testsInput = lines.indexOf('      tests:');
  const testsBlock = lines.slice(testsInput + 1, lines.findIndex((line, i) => i > testsInput && !line.startsWith('        ')));
  assert.ok(testsBlock.some((line) => line.trim() === "default: ''"), 'empty by default');
  assert.ok(!testsBlock.some((line) => /\ball\b/.test(line)), `no all among the values:\n${testsBlock.join('\n')}`);

  console.log('✓ a comment\'s run: a listed commenter, the head by SHA, a read-only token, no secret, no cache, main\'s comment script');

  // tests=timed: the platforms job reads test/timed.txt at the commit, as data, after it knows the commit
  const step = (job, name) => job.slice(job.indexOf(`- name: ${name}`), job.findIndex((line, i) => i > job.indexOf(`- name: ${name}`) && line.startsWith('- name:')));
  const timedStep = step(platformsJob, 'The timed tests');
  assert.ok(platformsJob.indexOf('- name: The commit and its PR') < platformsJob.indexOf('- name: The timed tests')
    && platformsJob.indexOf('- name: The timed tests') < platformsJob.indexOf('- name: Which platforms'), 'the commit, then its timed list, then the matrix');
  // The tests input reaches it as an environment variable, like every input (checked above), and the shell decides
  assert.ok(timedStep.includes('TESTS: ${{ inputs.tests }}') && timedStep.includes('SHA: ${{ steps.head.outputs.sha }}')
    && timedStep.includes('if [[ "$TESTS" == timed ]]; then') && !timedStep.some((line) => line.startsWith('if:')), timedStep.join('\n'));
  assert.ok(timedStep.includes('set -o pipefail')
    && timedStep.includes(String.raw`gh api "repos/$GITHUB_REPOSITORY/contents/test/timed.txt?ref=$SHA" --jq .content | base64 -d > "$RUNNER_TEMP/timed.txt"`),
    'the list read through the API at the commit, not checked out: the job runs no code from it');
  assert.ok(step(platformsJob, 'Which platforms').includes('TIMED_LIST: ${{ runner.temp }}/timed.txt'), 'the matrix reads that list');
  assert.ok(platformsJob.includes('matrix: ${{ steps.platforms.outputs.matrix }}'), 'the platforms job outputs the matrix');
  // The test job: a timed entry runs its one test without coverage, and keeps its results apart
  const unitJob = jobLines(workflow, 'unit').map((line) => line.trim());
  assert.ok(unitJob.includes('strategy:') && unitJob.some((line) => line === 'matrix: ${{ fromJSON(needs.platforms.outputs.matrix) }}'), 'the matrix from the platforms job');
  assert.ok(unitJob.includes("name: unit (${{ matrix.os }}${{ matrix.timed && format(', {0}', matrix.timed) || '' }})"), 'a timed job named after its test');
  const coverageStep = step(unitJob, 'Tests with coverage');
  assert.ok(coverageStep.includes('if: ${{ !matrix.timed }}'), 'a timed job runs no coverage');
  const timedTestStep = step(unitJob, 'A timed test, without coverage');
  // Through the step's environment, which any shell reads (Windows' default is pwsh): never into the command line
  assert.ok(timedTestStep.includes('if: ${{ matrix.timed }}') && timedTestStep.includes('TESTS: files:${{ matrix.timed }}')
    && timedTestStep.includes('run: npm run test:ci'), `its one test, through the environment:\n${timedTestStep.join('\n')}`);
  assert.ok(step(unitJob, 'Upload the test results').includes("name: results-${{ matrix.os }}${{ matrix.id && format('-{0}', matrix.id) || '' }}"), 'each timed job its own artifact');
  assert.ok(step(unitJob, 'Upload the coverage report').includes('if: ${{ always() && !matrix.timed }}'), 'and no coverage artifact');
  console.log('✓ tests=timed: the list read at the commit as data, a job per test without coverage, each with its own results');

  // The release-packages repro installs from the job's own npm cache, which npm ci has just filled, not an empty one:
  // from an empty cache its first install took 522 s on GitHub's Windows (REPRO_NPM_CACHE, read by the repro)
  const cacheStep = step(unitJob, 'The npm cache for the release repro');
  assert.ok(cacheStep.includes('shell: bash') && cacheStep.includes('run: echo "REPRO_NPM_CACHE=$(npm config get cache)" >> "$GITHUB_ENV"'),
    `the job's npm cache, named for the repro:\n${cacheStep.join('\n')}`);
  assert.ok(unitJob.indexOf('- name: Install') < unitJob.indexOf('- name: The npm cache for the release repro')
    && unitJob.indexOf('- name: The npm cache for the release repro') < unitJob.indexOf('- name: Tests with coverage'), 'after npm ci fills it, before the tests');
  console.log('✓ the release repro installs from the job\'s npm cache');

  // The test job installs with npm 11 on every platform: Node 22's npm 10 runs the prepare
  // build inside `npm pack` even with ignore-scripts, into the JSON the release test reads
  const steps = unit.map((line) => line.trim());
  const npm11 = steps.indexOf('run: npm install --global npm@11');
  assert.ok(npm11 > steps.findIndex((line) => line.startsWith('uses: actions/setup-node')) && npm11 < steps.indexOf('run: npm ci'),
    'the test job moves to npm 11 after setting up Node and before it installs');
  const stepStart = steps.lastIndexOf('- name: npm 11', npm11);
  const stepEnd = steps.findIndex((line, i) => i > npm11 && line.startsWith('- '));
  assert.ok(stepStart >= 0 && !steps.slice(stepStart, stepEnd).some((line) => line.startsWith('if:')), 'with no condition: on every platform');
  console.log('✓ the test job installs with npm 11, on every platform');

  // npm ci gets the job's own read-only token: @vscode/ripgrep's postinstall downloads
  // ripgrep through api.github.com, which refuses a shared runner's anonymous requests (403)
  const install = steps.indexOf('- name: Install');
  const installEnd = steps.findIndex((line, i) => i > install && line.startsWith('- '));
  const installStep = steps.slice(install, installEnd);
  assert.ok(installStep.includes('run: npm ci'), 'the Install step runs npm ci');
  assert.ok(installStep.includes('GITHUB_TOKEN: ${{ github.token }}'), 'npm ci gets the job\'s own token, for the ripgrep download');
  console.log('✓ npm ci gets the job\'s read-only token for the ripgrep download');
}

runIfMain(import.meta.url, run);
