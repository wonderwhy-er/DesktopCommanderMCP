/**
 * The AI review (.github/workflows/review.yml; helpers/ci-review.js), the same
 * on any machine and in CI:
 *
 *   npm run review -- <commit A>..<commit B>     node test/ci-review.js run A..B [--repo <dir>] [--out <dir>]
 *   npm run review -- A..B --text <file>         a text check: [--results <file>]... (--text pr: the PR's text)
 *   node test/ci-review.js request               CI: which PR, head and base this event reviews, if any
 *   node test/ci-review.js post <folder>         CI: the review on the PR, and for the job summary
 *
 * - run: the key first, from DC_GEMINI_API_KEY on a machine or the GEMINI_API_KEY
 *   secret in CI; without one it stops before any work and exits 1. Then Gemini
 *   CLI reviews the change from A to B (A...B, from where B left A) in a folder of
 *   its own: our settings (read-only tools), its own Gemini home, B's files in pr/
 *   (links as plain files) and the diff in review/. The prompt goes in on stdin:
 *   .github/review-prompt.md, the commits, the files, and with PR (and GH_TOKEN)
 *   the PR's title and description. Writes to --out (default test-results/review):
 *   review.json (the findings, each with its file and line), review.md, diff.patch
 *   and answer.json (Gemini CLI's own JSON). --repo is the git checkout (default
 *   this one).
 * - request: from GITHUB_EVENT_NAME and GITHUB_EVENT_PATH (helpers/ci-platforms.js'
 *   reviewFor); writes review (true or false), pr, sha and base to GITHUB_OUTPUT.
 *   A comment's PR, and an on-demand run's commit and base, come from the API.
 * - post: <folder>/review.json and diff.patch. With PR, one review with event
 *   COMMENT; then it prints every finding, for the job summary.
 * Environment (GitHub Actions sets the first two): GITHUB_REPOSITORY, GITHUB_API_URL,
 * GH_TOKEN; GEMINI_MODEL (optional) picks the model.
 */
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { isCounted } from './check-coverage-report.js';
import { reviewFor } from './helpers/ci-platforms.js';
import {
  answerOf, filesOf, findingsOf, localTestsOf, promptOf, reviewOf, testsOf, textAnswerOf, textCheckOf, textPromptOf,
  uncoveredOf, usageOf, withUncovered,
} from './helpers/ci-review.js';
import { githubApi } from './helpers/github-api.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { GITHUB_REPOSITORY: repo, GH_TOKEN: token } = process.env;
const github = githubApi({ api: process.env.GITHUB_API_URL ?? 'https://api.github.com', token });
// The Gemini CLI the review runs, and its one model: Google's newest Flash, pinned, so
// nothing routes a request to another model (GEMINI_MODEL can name another single one)
const GEMINI_CLI = '@google/gemini-cli@0.66.0';
const MODEL = 'gemini-3.8-flash';
// Every request resends the conversation, so the requests are what costs. The prompt carries
// the diff; the budget hook (test/ci-review-budget.js) lets TOOL_CALLS tool calls through and
// refuses the rest, so the model answers. MAX_TURNS is only a last stop: Gemini CLI ends the
// session there with no answer (exit 53)
const TOOL_CALLS = 8;
// A text check's git and gh commands are small reads, so it gets more of them
const TEXT_TOOL_CALLS = 16;
const MAX_TURNS = 20;
// Every request carries the whole prompt, so it may take at most MAX_PROMPT_TOKENS of the model's
// 1,048,576, leaving room for its reads and its answer (REVIEW_MAX_PROMPT_TOKENS for tests). Counted
// before any request, at about 3 characters a token: a 16,150-line diff, a 650 KB prompt, came to
// about 225,000 tokens a request
const CHARS_PER_TOKEN = 3;
const MAX_PROMPT_TOKENS = Number(process.env.REVIEW_MAX_PROMPT_TOKENS) || 800_000;
// Gemini CLI and everything it starts are stopped after this (REVIEW_TIMEOUT_MS for tests)
const TIMEOUT_MS = Number(process.env.REVIEW_TIMEOUT_MS) || 12 * 60 * 1000;
const SETTINGS = {
  // The loop detector is a second model's requests
  model: { maxSessionTurns: MAX_TURNS, disableLoopDetection: true },
  privacy: { usageStatisticsEnabled: false },
};
const READ_TOOLS = ['read_file', 'list_directory', 'glob', 'grep_search'];
// A text check may also run these, read-only, to check its claims about commits and runs (the budget
// hook refuses any other command, and any shell character)
const SHELL_TOOLS = ['git log', 'git show', 'git rev-parse', 'git merge-base', 'gh pr view', 'gh run view']
  .map((command) => `run_shell_command(${command})`);
const settingsFor = (shell) => ({ ...SETTINGS, tools: { core: shell ? [...READ_TOOLS, ...SHELL_TOOLS] : READ_TOOLS } });
// After the prompt on stdin (Gemini CLI appends --prompt to it)
const ASK = 'Review the change as the rules above say. Answer with the JSON object only.';

/** Lines for GITHUB_OUTPUT, also printed */
function output(text) {
  console.log(text);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${text}\n`);
}

/** A full commit SHA, or an error */
function sha(value, what) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${what} is no commit SHA: ${JSON.stringify(value)}`);
  }
  return value;
}

// A commit or a branch as given: no option, no space, nothing a shell reads
const isRef = (ref) => typeof ref === 'string' && /^\w[\w./~^@{}-]*$/.test(ref);

/** An on-demand run's commit or base (a SHA, short or full, or a branch) as a full SHA */
async function commitOf(ref, what) {
  if (!isRef(ref)) throw new Error(`${what} is no commit or branch: ${JSON.stringify(ref)}`);
  return sha((await github('GET', `/repos/${repo}/commits/${ref}`)).sha, what);
}

/** The PR, head and base an event that reviews is about */
async function targetOf(eventName, event) {
  if (eventName === 'pull_request') {
    const { head, base } = event.pull_request;
    return { pr: String(event.number), sha: sha(head.sha, 'head'), base: sha(base.sha, 'base') };
  }
  if (eventName === 'issue_comment') {
    const pull = await github('GET', `/repos/${repo}/pulls/${Number(event.issue.number)}`);
    return { pr: String(pull.number), sha: sha(pull.head.sha, 'head'), base: sha(pull.base.sha, 'base') };
  }
  // On demand: the open PR whose head the commit is gets the review; with none, the job summary only
  const head = await commitOf(event.inputs?.commit, 'commit');
  const base = await commitOf(event.inputs?.base, 'base');
  const pulls = await github('GET', `/repos/${repo}/commits/${head}/pulls`);
  const pull = pulls.find((each) => each.state === 'open' && each.head?.sha === head);
  return { pr: pull ? String(pull.number) : '', sha: head, base };
}

async function request() {
  // Called by tests.yml after its tests: it decided already, and passes the PR, head and base
  if (process.env.CALLED_SHA) {
    const pr = process.env.CALLED_PR ?? '';
    if (!/^\d*$/.test(pr)) throw new Error(`CALLED_PR is no PR number: ${JSON.stringify(pr)}`);
    const head = sha(process.env.CALLED_SHA, 'CALLED_SHA');
    const base = sha(process.env.CALLED_BASE, 'CALLED_BASE');
    output([`review=true`, `pr=${pr}`, `sha=${head}`, `base=${base}`].join('\n'));
    return;
  }
  const eventName = process.env.GITHUB_EVENT_NAME;
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const review = reviewFor(eventName, event);
  const { pr, sha: head, base } = review ? await targetOf(eventName, event) : { pr: '', sha: '', base: '' };
  output([`review=${review}`, `pr=${pr}`, `sha=${head}`, `base=${base}`].join('\n'));
}

/** Stops a process and everything it started: on Windows killing the shell alone leaves npx's children running */
function stopTree(pid) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Already gone
  }
}

/**
 * Runs Gemini CLI with the prompt on stdin: { status, stdout, stderr, error, timedOut }; at the timeout, its whole
 * tree stops
 */
function runGemini(command, args, options, input) {
  return new Promise((resolve) => {
    // Its own process group on POSIX, so the timeout reaches its children too
    const child = spawn(command, args, { ...options, detached: process.platform !== 'win32' });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      stopTree(child.pid);
    }, TIMEOUT_MS);
    const done = (status, error) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, error, timedOut });
    };
    child.on('error', (error) => done(null, error));
    child.on('close', (status) => done(status));
    child.stdin.on('error', () => {
      // A child that ends without reading its stdin; its exit says why
    });
    child.stdin.end(input);
  });
}

/**
 * Why Gemini CLI stopped, in one line. An uncaught error of its own ends its stderr with Node's
 * version: its crash, named by its error line. Otherwise its JSON error, or that same line.
 */
function stoppedWhy({ status, stderr, error, log }) {
  const crashed = /^Node\.js v\d/m.test(stderr);
  const errorLine = stderr.split('\n').map((line) => line.trim()).find((line) => /^\w*(Error|Exception)\b/.test(line));
  const why = (crashed ? errorLine : error?.message ?? errorLine) ?? stderr.trim().split('\n').pop() ?? 'no output';
  const said = why.replace(/\s+/g, ' ').slice(0, 300).replace(/\.$/, '');
  return `Gemini CLI ${crashed ? 'crashed' : 'stopped'} (exit ${status}): ${said}. Its whole output: ${log}`;
}

/** Gemini CLI, or the stand-in a test names in REVIEW_GEMINI, as a command for spawn */
function geminiCommand(args) {
  if (process.env.REVIEW_GEMINI) return [process.execPath, [process.env.REVIEW_GEMINI, ...args], {}];
  // npx is a .cmd on Windows, which only a shell starts; every argument here is a plain word or the quoted ASK
  if (process.platform === 'win32') {
    const quoted = args.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg));
    return [['npx', '-y', GEMINI_CLI, ...quoted].join(' '), [], { shell: true }];
  }
  return ['npx', ['-y', GEMINI_CLI, ...args], {}];
}

/** The text a text check reads: a file's, or (pr) the PR's description, which run read already */
function textToCheck(source, pull) {
  if (source === 'pr') {
    if (!process.env.PR) throw new Error('No PR, so no description to check: --text pr needs the PR (PR=<number>).');
    return { file: `PR #${Number(process.env.PR)}`, text: pull.body ?? '' };
  }
  if (!fs.existsSync(source)) throw new Error(`No text to check at ${source}.`);
  return { file: path.basename(source), text: fs.readFileSync(source, 'utf8') };
}

/** The results files a text check is given (--results, any number), by name */
function resultsOf(files) {
  return files.map((file) => {
    if (!fs.existsSync(file)) throw new Error(`No results file at ${file}.`);
    return { name: path.basename(file), text: fs.readFileSync(file, 'utf8') };
  });
}

/** The change from A to B in a checkout: its git, its base and head as full SHAs, the diff and the commits */
function changeOf(range, repoDir) {
  const [from, to, more] = String(range ?? '').split('..');
  if (more !== undefined || !isRef(from) || !isRef(to)) {
    throw new Error(`Not a range A..B: ${JSON.stringify(range)}. Usage: npm run review -- <commit A>..<commit B>`);
  }
  const git = (args, env = {}) => {
    const done = spawnSync('git', ['-C', repoDir, ...args], {
      encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, ...env },
    });
    if (done.status !== 0) throw new Error(`git ${args.join(' ')}: ${done.stderr || done.error?.message}`);
    return done.stdout;
  };
  const base = git(['rev-parse', '--verify', '--end-of-options', `${from}^{commit}`]).trim();
  const head = git(['rev-parse', '--verify', '--end-of-options', `${to}^{commit}`]).trim();
  // The checkout's own diff settings (external diff, textconv) stay off
  const diff = git(['diff', '--no-color', '--no-ext-diff', '--no-textconv', `${base}...${head}`]);
  const commits = git(['log', '--reverse', '--format=%h %s', `${base}..${head}`]).split(/\r?\n/).filter(Boolean);
  return { git, base, head, diff, commits };
}

/** The prompt: a text check's (with --text), or the review's */
function promptFor({ change: { head, base, diff, commits }, pull, tests, text, results }) {
  const read = (file) => fs.readFileSync(path.join(ROOT, '.github', file), 'utf8');
  const shared = {
    style: read('writing-style.md'), headSha: head, baseSha: base, commits, diff, files: filesOf(diff), tests,
  };
  if (text) {
    return textPromptOf({
      ...shared, template: read('text-check-prompt.md'), file: text.file, text: text.text, results,
      calls: TEXT_TOOL_CALLS,
    });
  }
  return promptOf({
    ...shared, template: read('review-prompt.md'), title: pull.title, description: pull.body, calls: TOOL_CALLS,
  });
}

/** Stops before any request when the prompt leaves the model's window no room for its reads and its answer */
function fitsTheWindow(prompt, diff) {
  const tokens = Math.ceil(prompt.length / CHARS_PER_TOKEN);
  if (tokens <= MAX_PROMPT_TOKENS) return;
  const about = `the prompt is about ${tokens.toLocaleString('en-US')} tokens (${diff.split('\n').length} diff lines)`;
  const limit = MAX_PROMPT_TOKENS.toLocaleString('en-US');
  throw new Error(`Too big to review: ${about}, over the ${limit} the model's window leaves for it. `
    + 'Review it in parts: npm run review -- A..B for each.');
}

/** A text check's output: text-check.md and text-check.json, and on GitHub the job summary (it posts nothing) */
function writeTextCheck({ geminiJson, change: { head, base }, text, out }) {
  const answer = textAnswerOf(geminiJson.response);
  const markdown = textCheckOf({ answer, file: text.file, headSha: head });
  const { summary, findings, checked } = answer;
  const check = { head, base, file: text.file, summary, findings, checked, usage: usageOf(geminiJson.stats) };
  fs.writeFileSync(path.join(out, 'text-check.json'), `${JSON.stringify(check, null, 2)}\n`);
  fs.writeFileSync(path.join(out, 'text-check.md'), `${markdown}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  console.log(`${markdown.split('\n')[1]}\nThe text check: ${path.join(out, 'text-check.md')}`);
}

/** A review's output: review.json, with every finding by its file and line, and review.md */
function writeReview({ geminiJson, change: { head, base, diff }, tests, out }) {
  const answer = answerOf(geminiJson.response);
  const usage = usageOf(geminiJson.stats);
  const findings = withUncovered(findingsOf(answer, diff), tests?.uncovered ?? []);
  const review = { head, base, summary: answer.summary, findings, usage, tests };
  const markdown = reviewOf({ answer: review, diff, headSha: head, baseSha: base, usage, inline: false, tests }).body;
  fs.writeFileSync(path.join(out, 'review.json'), `${JSON.stringify(review, null, 2)}\n`);
  fs.writeFileSync(path.join(out, 'review.md'), `${markdown}\n`);
  const where = `The review: ${path.join(out, 'review.md')}\nIts findings: ${path.join(out, 'review.json')}`;
  console.log(`${markdown.split('\n')[1]}\n${where}`);
}

async function run(range, ...options) {
  // The key before anything else: without one, no work and no pass
  const key = process.env.DC_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error('No Gemini API key, so nothing was reviewed. On your machine, set DC_GEMINI_API_KEY; '
      + 'in CI, add the repository\'s GEMINI_API_KEY secret.');
  }
  const option = (name, fallback) => (options.includes(name) ? options[options.indexOf(name) + 1] : fallback);
  const every = (name) => options.flatMap((each, at) => (each === name ? [options[at + 1]] : []));
  const out = path.resolve(option('--out', path.join(ROOT, 'test-results', 'review')));
  const change = changeOf(range, option('--repo', ROOT));
  const pull = process.env.PR ? await github('GET', `/repos/${repo}/pulls/${Number(process.env.PR)}`) : {};
  // The run's tests (CI: its artifacts, --tests) or this machine's last coverage run at B
  const ran = option('--tests')
    ? testsOf(path.resolve(option('--tests')))
    : localTestsOf({ root: ROOT, head: change.head });
  const tests = ran && {
    platforms: ran.platforms,
    failed: ran.failed,
    // Only files the coverage counts: the rules the coverage check holds the report to (.c8rc.json's files)
    uncovered: uncoveredOf({ diff: change.diff, lcovs: ran.lcovs, counted: isCounted }),
  };
  // A text check (--text): each claim in a text against the change, with the results files it cites
  const text = option('--text') && textToCheck(option('--text'), pull);
  const prompt = promptFor({ change, pull, tests, text, results: text ? resultsOf(every('--results')) : [] });
  fitsTheWindow(prompt, change.diff);

  const { git, head, diff } = change;
  const geminiJson = await askGemini({ prompt, head, git, key, out, diff, shell: Boolean(text) });
  fs.writeFileSync(path.join(out, 'diff.patch'), diff);
  if (text) writeTextCheck({ geminiJson, change, text, out });
  else writeReview({ geminiJson, change, tests, out });
}

/** The model's folder: our settings, its own Gemini home with the budget hook, the diff, and B's files in pr/ */
function fillFolder({ folder, git, head, diff, shell }) {
  fs.mkdirSync(path.join(folder, '.gemini'));
  fs.writeFileSync(path.join(folder, '.gemini', 'settings.json'), JSON.stringify(settingsFor(shell), null, 2));
  // Its own Gemini home: a user's settings and servers don't apply. The budget hook goes in
  // its user settings, where Gemini CLI runs hooks it was given (project hooks are untrusted)
  fs.mkdirSync(path.join(folder, 'home', '.gemini'), { recursive: true });
  const slashed = (file) => file.replace(/\\/g, '/');
  const hook = slashed(path.join(ROOT, 'test', 'ci-review-budget.js'));
  const calls = shell ? TEXT_TOOL_CALLS : TOOL_CALLS;
  const budget = `node "${hook}" "${slashed(path.join(folder, 'home', 'requests'))}" ${calls}`;
  fs.writeFileSync(path.join(folder, 'home', '.gemini', 'settings.json'), JSON.stringify({
    hooks: { BeforeTool: [{ hooks: [{ type: 'command', name: 'review-budget', command: budget }] }] },
  }, null, 2));
  fs.mkdirSync(path.join(folder, 'review'));
  fs.writeFileSync(path.join(folder, 'review', 'diff.patch'), diff);
  // B's files through an index of our own: the checkout's index stays as it is, and a
  // link is written as a plain file, so no read follows it out of the folder
  const index = { GIT_INDEX_FILE: path.join(folder, 'index') };
  git(['read-tree', head], index);
  const prefix = `--prefix=${slashed(path.join(folder, 'pr'))}/`;
  git(['-c', 'core.symlinks=false', '-c', 'core.autocrlf=false', 'checkout-index', '--all', '--force', prefix], index);
  fs.rmSync(index.GIT_INDEX_FILE);
}

/** The model's environment: the key as Gemini CLI reads it and its own home; a GitHub token only for gh on GitHub */
function modelEnv({ key, folder, git, shell }) {
  const env = {
    ...process.env, GEMINI_API_KEY: key, GEMINI_CLI_TRUST_WORKSPACE: 'true', GEMINI_CLI_HOME: path.join(folder, 'home'),
  };
  for (const name of ['DC_GEMINI_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'GEMINI_MODEL']) delete env[name];
  if (!shell) return env;
  // git reads the checkout's repository from the model's folder; gh reads this repository only,
  // through the machine's own login; nothing pages or asks
  const noPager = { GIT_PAGER: 'cat', GH_PAGER: 'cat', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };
  Object.assign(env, noPager, { GIT_DIR: git(['rev-parse', '--absolute-git-dir']).trim() });
  if (repo) env.GH_REPO = repo;
  // On GitHub gh has no login of its own: the job's token, which only reads
  if (process.env.GITHUB_ACTIONS === 'true' && token) env.GH_TOKEN = token;
  return env;
}

/** Keeps Gemini CLI's session log, JSON and stderr in out, the key in none of them; returns the stderr's file */
function keepOutputs({ gemini, folder, key, out }) {
  // Its session log, to see what it read and how often (the folder goes in the end)
  const chats = path.join(folder, 'home', '.gemini', 'tmp');
  const logs = (fs.existsSync(chats) ? fs.readdirSync(chats, { recursive: true }) : [])
    .filter((file) => String(file).endsWith('.jsonl'));
  const session = logs.map((file) => fs.readFileSync(path.join(chats, file), 'utf8')).join('');
  fs.mkdirSync(out, { recursive: true });
  if (session && !session.includes(key)) fs.writeFileSync(path.join(out, 'session.jsonl'), session);
  // Its JSON has its token counts, also when it stops without an answer
  fs.writeFileSync(path.join(out, 'answer.json'), gemini.stdout);
  const log = path.join(out, 'gemini.log');
  fs.writeFileSync(log, gemini.stderr.split(key).join('<the Gemini key>'));
  return log;
}

/**
 * Gemini CLI on the prompt, in a folder of its own with B's files and the diff, read-only tools and the reading
 * budget. Returns its JSON; its session log, its JSON and its stderr are kept in out
 */
async function askGemini({ prompt, head, git, key, out, diff, shell }) {
  // Nothing in its folder but what we put there. By its real path, as Gemini CLI sees its
  // working folder (macOS's temp folder is behind a link)
  const folder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-review-')));
  try {
    fillFolder({ folder, git, head, diff, shell });
    const model = process.env.GEMINI_MODEL || MODEL;
    const flags = ['--model', model, '--approval-mode=yolo', '--output-format', 'json', '--prompt', ASK];
    const [command, args, extra] = geminiCommand(flags);
    const env = modelEnv({ key, folder, git, shell });
    const gemini = await runGemini(command, args, { cwd: folder, env, ...extra }, prompt);
    if (gemini.timedOut) {
      const seconds = Math.round(TIMEOUT_MS / 1000);
      throw new Error(`Gemini CLI didn't answer within ${seconds} s: it and the processes it started were stopped.`);
    }
    if (gemini.error) throw new Error(`Gemini CLI didn't run: ${gemini.error.message}`);
    if (gemini.stdout.includes(key)) {
      throw new Error('The model\'s answer holds the Gemini key: no review was written.');
    }
    const log = keepOutputs({ gemini, folder, key, out });
    if (gemini.status === 53) {
      throw new Error(`Gemini CLI used all ${MAX_TURNS} turns without an answer (exit 53): no review was written. `
        + `Its session log: ${path.join(out, 'session.jsonl')}`);
    }
    let geminiJson = {};
    try {
      geminiJson = JSON.parse(gemini.stdout.slice(gemini.stdout.indexOf('{')));
    } catch {
      // Not Gemini CLI's JSON: the exit code and stderr say why
    }
    if (gemini.status !== 0) {
      const stderr = gemini.stderr.split(key).join('<the Gemini key>');
      throw new Error(stoppedWhy({ status: gemini.status, stderr, error: geminiJson.error, log }));
    }
    return geminiJson;
  } finally {
    // A file still held open mustn't hide the error that got us here
    try {
      fs.rmSync(folder, { recursive: true, force: true });
    } catch (error) {
      console.error(`Couldn't remove the model's folder ${folder}: ${error.message}`);
    }
  }
}

async function post(folder) {
  const saved = JSON.parse(fs.readFileSync(path.join(folder, 'review.json'), 'utf8'));
  const { head, base, summary, findings, usage, tests } = saved;
  const diff = fs.readFileSync(path.join(folder, 'diff.patch'), 'utf8');
  const shown = {
    answer: { summary, findings }, diff, headSha: sha(head, 'head'), baseSha: sha(base, 'base'), usage, tests,
  };
  // The job summary first: every finding, with or without a PR, and also when GitHub refuses the review
  console.log(reviewOf({ ...shown, inline: false }).body);
  if (!process.env.PR) return;
  const url = `/repos/${repo}/pulls/${Number(process.env.PR)}/reviews`;
  try {
    await github('POST', url, reviewOf(shown));
  } catch (error) {
    // GitHub didn't take the line comments: 422 for a line outside the PR's own diff, and a 500 for a review with
    // eleven of them (#970); the summary takes them all
    if (error.status !== 422 && !(error.status >= 500)) throw error;
    console.error(`${error.message}\nPosting every finding in the summary instead.`);
    await github('POST', url, reviewOf({ ...shown, inline: false }));
  }
}

const [command, ...args] = process.argv.slice(2);
const commands = { request, run, post };
if (!commands[command]) {
  console.error('Usage: npm run review -- <commit A>..<commit B> [--text <file> [--results <file>]...]'
    + ' | node test/ci-review.js request | post <folder>');
  process.exitCode = 2;
} else {
  commands[command](...args).catch((error) => {
    // One plain line, here and in the run's job summary: a review that didn't happen never passes, and never
    // shows as a crash
    console.error(error.message);
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `**AI review: not done.** ${error.message}\n`);
    }
    process.exitCode = 1;
  });
}
