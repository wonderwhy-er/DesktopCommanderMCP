/**
 * Which platforms a CI run tests, and the PR comment
 * (.github/workflows/tests.yml through test/ci-platforms.js, and test/ci-comment.js),
 * and when the AI review runs (.github/workflows/review.yml through test/ci-review.js):
 * - only the maintainers start a PR's run or a review: PRs they opened, comments
 *   they wrote, on-demand reviews they started. Both workflows check MAINTAINERS
 *   here. An on-demand tests run is for anyone GitHub lets start it (write access);
 * - only the platforms whose label the PR has run: `linux`, `windows`, `macos`;
 *   with none of them, nothing runs;
 * - a push (a PR pushed to or reopened) runs every labelled platform; a new PR's
 *   labels each run their platform through their labeled event, once;
 * - adding one of those labels runs just its platform, at once; another label,
 *   or removing one, runs nothing;
 * - a new comment on the PR with a line `/test <platforms>` runs those: `linux`,
 *   `windows`, `macos`, several at once (`/test windows macos`);
 * - an on-demand run (`gh workflow run tests.yml -f platforms=linux,windows …`)
 *   runs the platforms it names, Linux when none; `tests=docker` runs on Linux only;
 * - the review runs on a push to a PR with the label `review`, on adding that
 *   label, on a comment line `/review`, and on demand (`gh workflow run review.yml`).
 * The PR comment has no prose: a heading with the commit, a results table with a
 * row per platform, a coverage table, and the lines by area, collapsed. Each
 * platform's results are kept in it as hidden data, so a run replaces its own
 * platforms' rows and keeps the others' last results.
 */

// Each platform's name is also its label, and its word after /test
export const PLATFORMS = [
  { name: 'linux', os: 'ubuntu-latest', label: 'Linux' },
  { name: 'windows', os: 'windows-latest', label: 'Windows' },
  { name: 'macos', os: 'macos-latest', label: 'macOS' },
];
// The PR comment's first line: CI edits the comment that starts with it
export const MARKER = '<!-- tests-and-coverage -->';
// Who starts a run in either workflow. An explicit list: author_association
// COLLABORATOR would also cover anyone given access later.
export const MAINTAINERS = ['wonderwhy-er', 'mihailt', 'ds-dcmpc', 'edgarsskore', 'Rkrizanovskis', 'serg33v'];
// The label that reviews a PR on every push
export const REVIEW_LABEL = 'review';

/** Whether a login is a maintainer's, in any case, as GitHub's own contains() compares them */
export const isMaintainer = (login) => typeof login === 'string' && MAINTAINERS.some((name) => name.toLowerCase() === login.toLowerCase());

/** Who started a run: the comment's writer, the on-demand run's starter, or the PR's author */
function startedBy(eventName, event) {
  if (eventName === 'issue_comment') return event.comment?.user?.login;
  if (eventName === 'workflow_dispatch') return event.sender?.login;
  return event.pull_request?.user?.login;
}

const inOrder = (names) => PLATFORMS.map(({ name }) => name).filter((name) => names.includes(name));
// The platforms whose label a PR (an event's pull_request, or a comment's issue) has
const labelledOn = (pullOrIssue) => inOrder((pullOrIssue?.labels ?? []).map(({ name }) => name));

/** The platforms a comment asks for: every line that starts with /test, e.g. `/test windows macos` */
export function commandPlatforms(body) {
  const names = [];
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const command = /^\s*\/test(\s.*)?$/i.exec(line);
    if (command) names.push(...(command[1] ?? '').toLowerCase().split(/[\s,|]+/));
  }
  return inOrder(names);
}

/** The platforms a run tests, from the event's name and payload (GITHUB_EVENT_NAME, GITHUB_EVENT_PATH) */
export function platformsFor(eventName, event) {
  // A PR or a comment by anyone but the maintainers runs nothing; on demand, GitHub's write access decides
  if (eventName !== 'workflow_dispatch' && !isMaintainer(startedBy(eventName, event))) return [];
  if (eventName === 'issue_comment') {
    if (event.action !== 'created' || !event.issue?.pull_request) return [];
    // A /review line runs the PR's labelled platforms too, so the review comes after their tests
    const forReview = commandReview(event.comment?.body) ? labelledOn(event.issue) : [];
    return inOrder([...commandPlatforms(event.comment?.body), ...forReview]);
  }
  if (eventName === 'workflow_dispatch') {
    // An on-demand run: the platforms it names, Linux when none; Docker's tests run on Linux only
    const inputs = event.inputs ?? {};
    const names = String(inputs.tests ?? '').trim() === 'docker' ? ['linux'] : inOrder(String(inputs.platforms ?? '').toLowerCase().split(/[\s,|]+/));
    return names.length > 0 ? names : ['linux'];
  }
  if (eventName !== 'pull_request') return [];
  // A label runs just its own platform; review runs none (each platform ran on its own label's event, and a push
  // runs them all), so a new PR runs each once and the review alone, once
  if (event.action === 'labeled') return inOrder([event.label?.name]);
  // Not opened: a new PR's labels come as labeled events, each running its platform
  if (!['synchronize', 'reopened'].includes(event.action)) return [];
  return labelledOn(event.pull_request);
}

/** Whether a comment asks for a review: a line that is just `/review` */
export const commandReview = (body) => String(body ?? '').split(/\r?\n/).some((line) => /^\s*\/review\s*$/i.test(line));

/** Whether a run reviews (review.yml): the label on a push or when added, a /review comment on a PR, or on demand */
export function reviewFor(eventName, event) {
  if (!isMaintainer(startedBy(eventName, event))) return false;
  if (eventName === 'workflow_dispatch') return true;
  if (eventName === 'issue_comment') return event.action === 'created' && Boolean(event.issue?.pull_request) && commandReview(event.comment?.body);
  if (eventName !== 'pull_request') return false;
  if (event.action === 'labeled') return event.label?.name === REVIEW_LABEL;
  // Not opened: tests.yml doesn't get it, and a new PR's review label reviews through its own event
  return ['synchronize', 'reopened'].includes(event.action) && (event.pull_request?.labels ?? []).some(({ name }) => name === REVIEW_LABEL);
}

/** The runner images of some platforms: the test job's matrix */
export const osOf = (names) => PLATFORMS.filter(({ name }) => names.includes(name)).map(({ os }) => os);

/**
 * The tests test/timed.txt names, from its text as the platforms job reads it at
 * the commit: each line's name, before its # reason. This doesn't check the list:
 * a timed job gets its test by name (files:), which no list check reads, so a
 * bad line shows in any other run of the commit (readTestList in
 * node-test-runner.js stops on it).
 */
export const timedNamesIn = (text) => String(text).split(/\r?\n/).map((line) => line.replace(/#.*/, '').trim()).filter(Boolean);

/**
 * The test job's matrix: a job per platform ({ os }), or for an on-demand
 * tests=timed a job per timed test and platform, each on its own runner
 * ({ include: [{ os, timed, id }] }; the id names its results artifact)
 */
export function matrixFor(os, { tests, timed = [] }) {
  if (tests !== 'timed') return { os };
  if (timed.length === 0) return { os: [] };
  return { include: os.flatMap((image) => timed.map((name) => ({ os: image, timed: name, id: timedId(name) }))) };
}

// A timed job's artifact id, from its test (an artifact name can't hold a /): timed-repro-test-x.js
const timedId = (test) => `timed-${test.replaceAll('/', '-')}`;

/**
 * The results artifact a test job of `os` uploads: results-<runner> for unit
 * (<runner>), results-<runner>-timed-<test> for a timed run's unit (<runner>, <test>)
 */
export function resultsArtifactOf(job, os) {
  const test = job.name.startsWith(`unit (${os}, `) ? job.name.slice(`unit (${os}, `.length, -1) : undefined;
  return { test, artifact: test ? `results-${os}-${timedId(test)}` : `results-${os}` };
}

/** Text from an artifact or an older comment (a step name, an area) as plain inline text: no markup, no line breaks */
export const plain = (text) => String(text).replace(/[`<>|\r\n]/g, '');

const count = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const percent = ([covered, total], digits, cut) => (count(total) > 0 ? cut((10 ** (digits + 2) * count(covered)) / count(total)) / 10 ** digits : 100);
// The coverage table cuts to two decimals, as c8's own report does; the areas round to one, as the run's table does
const ratio = (pair) => (Array.isArray(pair) ? `${percent(pair, 2, Math.floor)} %` : '–');
const lines = (pair) => (Array.isArray(pair) ? `${percent(pair, 1, Math.round)} % (${count(pair[0])}/${count(pair[1])})` : '–');
const link = (text, url) => (typeof url === 'string' && /^https:\/\/[^\s()<>[\]|`]+$/.test(url) ? `[${text}](${url})` : '–');
const commit = (sha) => `\`${plain(sha ?? '').slice(0, 7)}\``;

/**
 * One platform's results, as ci-comment.js gathers them and the comment keeps them:
 * { sha, ran (what it tested, e.g. `everything`), minutes (the test job's, null
 * while it runs), tests: { files, passed, skipped, failed: [paths], notes: [why a
 * part didn't run], excluded: how many } or null, stoppedAt (the failed step
 * when there are no results), coverage: { lines, branches, functions: [covered,
 * total] } or null, areas: [[area, covered lines, lines]], links: { run,
 * coverage, results } }
 */
function testsCell({ tests, stoppedAt }) {
  if (!tests) return `❌ no results${stoppedAt ? `: “${plain(stoppedAt)}” failed` : ''}`;
  // A part that didn't run says why: "Docker: GitHub's macOS runner has no Docker"
  const notes = (tests.notes ?? []).map((note) => `; ${plain(note)}`).join('');
  // The tests test/excluded.txt leaves out, counted: they never run in CI
  const excluded = tests.excluded ? `; ${count(tests.excluded)} excluded (test/excluded.txt)` : '';
  // Checks a file skipped (a tool missing on the machine): its file passes, so the cell says how many
  const skipped = count(tests.skipped) ? `; ${count(tests.skipped)} check${count(tests.skipped) === 1 ? '' : 's'} skipped` : '';
  // Fail closed: no test file ran is no pass
  if (!count(tests.files)) return `❌ no test file ran${notes}${excluded}${skipped}`;
  return `${tests.failed?.length ? '❌' : '✅'} ${count(tests.passed)} of ${count(tests.files)} files passed${notes}${excluded}${skipped}`;
}

/** A job's whole minutes from its start to its end (at least 1), or null while it's still going */
export function minutesOf(startedAt, completedAt) {
  const ms = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isFinite(ms) ? Math.max(1, Math.round(ms / 60000)) : null;
}

/** A run's test jobs for one platform: unit (<runner>), or a timed run's unit (<runner>, <test>) */
export const platformJobs = (jobs, os) => jobs.filter((job) => job.name === `unit (${os})` || job.name.startsWith(`unit (${os}, `));

/**
 * A platform's minutes in a run: from its first test job's start to its last one's
 * end (a timed run has a job per test), null while one still runs, undefined
 * when the run has none for it
 */
export function platformMinutes(jobs, os) {
  const own = platformJobs(jobs, os);
  if (own.length === 0) return undefined;
  if (own.some((job) => !job.completed_at)) return null;
  const first = own.map((job) => job.started_at).sort()[0];
  const last = own.map((job) => job.completed_at).sort().at(-1);
  return minutesOf(first, last);
}

// What the run tested, and its minutes: a row kept from before these columns has neither
const ranCell = ({ ran }) => (ran === undefined ? '–' : `\`${plain(ran)}\``);
const minutesCell = ({ minutes }) => {
  if (minutes === undefined) return '–';
  return minutes === null ? '…' : String(count(minutes));
};

/** The coverage table's Combined row: a figure only from one run's three reports, else why there's none */
function combinedRow(combined) {
  const { lines: covered, branches, functions } = combined?.coverage ?? {};
  const why = combined?.coverage ? '–' : plain(combined?.missing ?? 'needs Linux, Windows and macOS in one run');
  return `| **Combined** | ${ratio(covered)} | ${ratio(branches)} | ${ratio(functions)} | ${why} | – |`;
}

/** Lines per area, a column each ({ label, areas, total }): a single total hides where the gaps are */
function areaTable(columns) {
  const cell = (list, area) => lines(list.find(([each]) => plain(each) === area)?.slice(1));
  const areas = [...new Set(columns.flatMap((column) => column.areas.map(([area]) => plain(area))))].sort();
  const row = (name, cells) => `| ${name} | ${cells.join(' | ')} |`;
  return ['', '<details><summary>Lines by area</summary>', '',
    row('Area', columns.map(({ label }) => label)),
    `|---|${columns.map(() => '---').join('|')}|`,
    ...areas.map((area) => row(`\`${area}\``, columns.map((column) => cell(column.areas, area)))),
    row('**total**', columns.map(({ total }) => lines(total))),
    '', '</details>'];
}

/**
 * The PR comment for some platforms' results ({ linux: results, … }); a
 * cross-test's (testsFrom, the commit whose tests ran) names both commits.
 * combined: the three platforms together, where the 100 % target is, from this
 * run's three reports ({ coverage, areas } as a platform's), or { missing: why
 * there's no figure }; none is "needs Linux, Windows and macOS in one run"
 */
export function renderComment({ headSha, testsFrom, platforms, combined }) {
  const ran = PLATFORMS.filter(({ name }) => platforms[name]);
  const testsNamed = testsFrom ? `, tests from ${commit(testsFrom)}` : '';
  const out = [MARKER, `## Tests and coverage for ${commit(headSha)}${testsNamed}`];
  if (ran.length > 0) {
    out.push('', '| Platform | Tests | Ran | Minutes | Commit | Run |', '|---|---|---|---|---|---|');
    for (const { name, label } of ran) {
      const results = platforms[name];
      out.push(`| ${label} | ${testsCell(results)} | ${ranCell(results)} | ${minutesCell(results)} | ${commit(results.sha)} | ${link('run', results.links?.run)} |`);
    }
    out.push('', '| Platform | Lines | Branches | Functions | Report (HTML, lcov, JSON, Cobertura) | Results (JUnit, JSON, TAP) |', '|---|---|---|---|---|---|');
    for (const { name, os, label } of ran) {
      const { coverage, links } = platforms[name];
      out.push(`| ${label} | ${ratio(coverage?.lines)} | ${ratio(coverage?.branches)} | ${ratio(coverage?.functions)}`
        + ` | ${link(`coverage-${os}`, links?.coverage)} | ${link(`results-${os}`, links?.results)} |`);
    }
    if (ran.some(({ name }) => platforms[name].coverage)) out.push(combinedRow(combined));
    const columns = ran.filter(({ name }) => platforms[name].areas?.length)
      .map(({ name, label }) => ({ label, areas: platforms[name].areas, total: platforms[name].coverage?.lines }));
    if (columns.length > 0) {
      if (combined?.coverage && combined.areas?.length) {
        columns.push({ label: 'Combined', areas: combined.areas, total: combined.coverage.lines });
      }
      out.push(...areaTable(columns));
    }
  }
  // Each platform's results, for the next run to keep the platforms it doesn't run
  out.push('', ...ran.map(({ name }) => `<!-- platform-data:${name} ${Buffer.from(JSON.stringify(platforms[name])).toString('base64')} -->`));
  return out.join('\n');
}

/** The platforms' results an earlier comment keeps, by platform name; anything else is left out */
export function dataOf(body) {
  const data = {};
  for (const [, name, encoded] of String(body ?? '').matchAll(/^<!-- platform-data:(\w+) ([A-Za-z0-9+/=]+) -->$/gm)) {
    if (!PLATFORMS.some((platform) => platform.name === name)) continue;
    try {
      const results = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      if (typeof results?.sha === 'string') data[name] = results;
    } catch {
      // Not data this script wrote: left out
    }
  }
  return data;
}

/**
 * The PR comment after a run: this run's platforms' results, and the earlier
 * comment's for the others; the combined figure is this run's own
 */
export const mergeComment = ({ headSha, data, earlier, combined }) => renderComment({
  headSha, platforms: { ...dataOf(earlier), ...data }, combined,
});
