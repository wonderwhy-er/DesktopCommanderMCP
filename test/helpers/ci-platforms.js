/**
 * Which platforms a CI run tests, and the PR comment
 * (.github/workflows/tests.yml through test/ci-platforms.js, and test/ci-comment.js):
 * - only the maintainers start a PR's run: PRs they opened, comments they wrote.
 *   The workflow checks MAINTAINERS here. An on-demand run is for anyone GitHub
 *   lets start it (write access);
 * - only the platforms whose label the PR has run: `linux`, `windows`, `macos`;
 *   with none of them, nothing runs;
 * - a push (a PR opened, pushed to or reopened) runs every labelled platform;
 * - adding one of those labels runs just its platform, at once; another label,
 *   or removing one, runs nothing;
 * - a new comment on the PR with a line `/test <platforms>` runs those: `linux`,
 *   `windows`, `macos`, several at once (`/test windows macos`);
 * - an on-demand run (`gh workflow run tests.yml -f platforms=linux,windows …`)
 *   runs the platforms it names, Linux when none; `tests=docker` runs on Linux only.
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
// Who starts a PR's run. An explicit list: author_association COLLABORATOR
// would also cover anyone given access later.
export const MAINTAINERS = ['wonderwhy-er', 'mihailt', 'ds-dcmpc', 'edgarsskore', 'Rkrizanovskis', 'serg33v'];

/** Whether a login is a maintainer's, in any case, as GitHub's own contains() compares them */
export const isMaintainer = (login) => typeof login === 'string' && MAINTAINERS.some((name) => name.toLowerCase() === login.toLowerCase());

/** Who started a PR's run: the comment's writer, or the PR's author */
function startedBy(eventName, event) {
  if (eventName === 'issue_comment') return event.comment?.user?.login;
  return event.pull_request?.user?.login;
}

const inOrder = (names) => PLATFORMS.map(({ name }) => name).filter((name) => names.includes(name));

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
    return event.action === 'created' && event.issue?.pull_request ? commandPlatforms(event.comment?.body) : [];
  }
  if (eventName === 'workflow_dispatch') {
    // An on-demand run: the platforms it names, Linux when none; Docker's tests run on Linux only
    const inputs = event.inputs ?? {};
    const names = String(inputs.tests ?? '').trim() === 'docker' ? ['linux'] : inOrder(String(inputs.platforms ?? '').toLowerCase().split(/[\s,|]+/));
    return names.length > 0 ? names : ['linux'];
  }
  if (eventName !== 'pull_request') return [];
  if (event.action === 'labeled') return inOrder([event.label?.name]);
  if (!['opened', 'synchronize', 'reopened'].includes(event.action)) return [];
  return inOrder((event.pull_request?.labels ?? []).map(({ name }) => name));
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

/** The PR comment for some platforms' results ({ linux: results, … }) */
export function renderComment({ headSha, platforms }) {
  const ran = PLATFORMS.filter(({ name }) => platforms[name]);
  const out = [MARKER, `## Tests and coverage for ${commit(headSha)}`];
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
    // Lines per area, a column per platform: a single total hides where the gaps are
    const withAreas = ran.filter(({ name }) => platforms[name].areas?.length);
    if (withAreas.length > 0) {
      const areaOf = (name, area) => platforms[name].areas.find(([each]) => plain(each) === area);
      const areas = [...new Set(withAreas.flatMap(({ name }) => platforms[name].areas.map(([area]) => plain(area))))].sort();
      out.push('', '<details><summary>Lines by area</summary>', '',
        `| Area | ${withAreas.map(({ label }) => label).join(' | ')} |`,
        `|---|${withAreas.map(() => '---').join('|')}|`,
        ...areas.map((area) => `| \`${area}\` | ${withAreas.map(({ name }) => lines(areaOf(name, area)?.slice(1))).join(' | ')} |`),
        `| **total** | ${withAreas.map(({ name }) => lines(platforms[name].coverage?.lines)).join(' | ')} |`,
        '', '</details>');
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

/** The PR comment after a run: this run's platforms' results, and the earlier comment's for the others */
export const mergeComment = ({ headSha, data, earlier }) => renderComment({ headSha, platforms: { ...dataOf(earlier), ...data } });
