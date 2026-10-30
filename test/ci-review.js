/**
 * The AI review (.github/workflows/review.yml; helpers/ci-review.js), the same
 * on any machine and in CI:
 *
 *   npm run review -- <commit A>..<commit B>     node test/ci-review.js run A..B [--repo <dir>] [--out <dir>]
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
import { reviewFor } from './helpers/ci-platforms.js';
import { answerOf, filesOf, findingsOf, promptOf, reviewOf, usageOf } from './helpers/ci-review.js';
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
const MAX_TURNS = 20;
// Gemini CLI and everything it starts are stopped after this (REVIEW_TIMEOUT_MS for tests)
const TIMEOUT_MS = Number(process.env.REVIEW_TIMEOUT_MS) || 12 * 60 * 1000;
const SETTINGS = {
  // The loop detector is a second model's requests
  model: { maxSessionTurns: MAX_TURNS, disableLoopDetection: true },
  privacy: { usageStatisticsEnabled: false },
  tools: { core: ['read_file', 'list_directory', 'glob', 'grep_search'] },
};
// After the prompt on stdin (Gemini CLI appends --prompt to it)
const ASK = 'Review the change as the rules above say. Answer with the JSON object only.';

/** Lines for GITHUB_OUTPUT, also printed */
function output(text) {
  console.log(text);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${text}\n`);
}

/** A full commit SHA, or an error */
function sha(value, what) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) throw new Error(`${what} is no commit SHA: ${JSON.stringify(value)}`);
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
    return { pr: String(event.number), sha: sha(event.pull_request.head.sha, 'head'), base: sha(event.pull_request.base.sha, 'base') };
  }
  if (eventName === 'issue_comment') {
    const pull = await github('GET', `/repos/${repo}/pulls/${Number(event.issue.number)}`);
    return { pr: String(pull.number), sha: sha(pull.head.sha, 'head'), base: sha(pull.base.sha, 'base') };
  }
  // On demand: the open PR whose head the commit is gets the review; with none, the job summary only
  const head = await commitOf(event.inputs?.commit, 'commit');
  const base = await commitOf(event.inputs?.base, 'base');
  const pull = (await github('GET', `/repos/${repo}/commits/${head}/pulls`)).find((each) => each.state === 'open' && each.head?.sha === head);
  return { pr: pull ? String(pull.number) : '', sha: head, base };
}

async function request() {
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

/** Runs Gemini CLI with the prompt on stdin: { status, stdout, stderr, error, timedOut }; at the timeout, its whole tree stops */
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

/** Gemini CLI, or the stand-in a test names in REVIEW_GEMINI, as a command for spawn */
function geminiCommand(args) {
  if (process.env.REVIEW_GEMINI) return [process.execPath, [process.env.REVIEW_GEMINI, ...args], {}];
  // npx is a .cmd on Windows, which only a shell starts; every argument here is a plain word or the quoted ASK
  if (process.platform === 'win32') return [['npx', '-y', GEMINI_CLI, ...args.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg))].join(' '), [], { shell: true }];
  return ['npx', ['-y', GEMINI_CLI, ...args], {}];
}

async function run(range, ...options) {
  // The key before anything else: without one, no work and no pass
  const key = process.env.DC_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error('No Gemini API key, so nothing was reviewed. On your machine, set DC_GEMINI_API_KEY; '
      + 'in CI, add the repository\'s GEMINI_API_KEY secret.');
  }
  const option = (name, fallback) => (options.includes(name) ? options[options.indexOf(name) + 1] : fallback);
  const repoDir = option('--repo', ROOT);
  const out = path.resolve(option('--out', path.join(ROOT, 'test-results', 'review')));
  const [from, to, more] = String(range ?? '').split('..');
  if (more !== undefined || !isRef(from) || !isRef(to)) throw new Error(`Not a range A..B: ${JSON.stringify(range)}. Usage: npm run review -- <commit A>..<commit B>`);

  const git = (args, env = {}) => {
    const result = spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, ...env } });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr || result.error?.message}`);
    return result.stdout;
  };
  const base = git(['rev-parse', '--verify', '--end-of-options', `${from}^{commit}`]).trim();
  const head = git(['rev-parse', '--verify', '--end-of-options', `${to}^{commit}`]).trim();
  // The checkout's own diff settings (external diff, textconv) stay off
  const diff = git(['diff', '--no-color', '--no-ext-diff', '--no-textconv', `${base}...${head}`]);
  const commits = git(['log', '--reverse', '--format=%h %s', `${base}..${head}`]).split(/\r?\n/).filter(Boolean);
  const pull = process.env.PR ? await github('GET', `/repos/${repo}/pulls/${Number(process.env.PR)}`) : {};
  const prompt = promptOf({
    template: fs.readFileSync(path.join(ROOT, '.github', 'review-prompt.md'), 'utf8'),
    style: fs.readFileSync(path.join(ROOT, '.github', 'writing-style.md'), 'utf8'),
    headSha: head,
    baseSha: base,
    files: filesOf(diff),
    title: pull.title,
    description: pull.body,
    commits,
    diff,
    calls: TOOL_CALLS,
  });

  // The model's folder: nothing in it but what we put there. By its real path, as
  // Gemini CLI sees its working folder (macOS's temp folder is behind a link)
  const folder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-review-')));
  try {
    fs.mkdirSync(path.join(folder, '.gemini'));
    fs.writeFileSync(path.join(folder, '.gemini', 'settings.json'), JSON.stringify(SETTINGS, null, 2));
    // Its own Gemini home: a user's settings and servers don't apply. The budget hook goes in
    // its user settings, where Gemini CLI runs hooks it was given (project hooks are untrusted)
    fs.mkdirSync(path.join(folder, 'home', '.gemini'), { recursive: true });
    const budget = `node "${path.join(ROOT, 'test', 'ci-review-budget.js').replace(/\\/g, '/')}" "${path.join(folder, 'home', 'requests').replace(/\\/g, '/')}" ${TOOL_CALLS}`;
    fs.writeFileSync(path.join(folder, 'home', '.gemini', 'settings.json'), JSON.stringify({
      hooks: { BeforeTool: [{ hooks: [{ type: 'command', name: 'review-budget', command: budget }] }] },
    }, null, 2));
    fs.mkdirSync(path.join(folder, 'review'));
    fs.writeFileSync(path.join(folder, 'review', 'diff.patch'), diff);
    // B's files through an index of our own: the checkout's index stays as it is, and a
    // link is written as a plain file, so no read follows it out of the folder
    const index = { GIT_INDEX_FILE: path.join(folder, 'index') };
    git(['read-tree', head], index);
    git(['-c', 'core.symlinks=false', '-c', 'core.autocrlf=false', 'checkout-index', '--all', '--force', `--prefix=${path.join(folder, 'pr').replace(/\\/g, '/')}/`], index);
    fs.rmSync(index.GIT_INDEX_FILE);

    // The model gets the key as Gemini CLI reads it, and no GitHub token
    const env = { ...process.env, GEMINI_API_KEY: key, GEMINI_CLI_TRUST_WORKSPACE: 'true', GEMINI_CLI_HOME: path.join(folder, 'home') };
    for (const name of ['DC_GEMINI_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN']) delete env[name];
    delete env.GEMINI_MODEL;
    const model = process.env.GEMINI_MODEL || MODEL;
    const [command, args, extra] = geminiCommand(['--model', model, '--approval-mode=yolo', '--output-format', 'json', '--prompt', ASK]);
    const gemini = await runGemini(command, args, { cwd: folder, env, ...extra }, prompt);
    if (gemini.timedOut) throw new Error(`Gemini CLI didn't answer within ${Math.round(TIMEOUT_MS / 1000)} s: it and the processes it started were stopped.`);
    if (gemini.error) throw new Error(`Gemini CLI didn't run: ${gemini.error.message}`);
    if (gemini.stdout.includes(key)) throw new Error('The model\'s answer holds the Gemini key: no review was written.');
    // Its session log, to see what it read and how often (the folder goes in the end)
    const chats = path.join(folder, 'home', '.gemini', 'tmp');
    const logs = (fs.existsSync(chats) ? fs.readdirSync(chats, { recursive: true }) : []).filter((file) => String(file).endsWith('.jsonl'));
    const session = logs.map((file) => fs.readFileSync(path.join(chats, file), 'utf8')).join('');
    fs.mkdirSync(out, { recursive: true });
    if (session && !session.includes(key)) fs.writeFileSync(path.join(out, 'session.jsonl'), session);
    // Gemini CLI's own JSON, with its token counts, also when it stops without an answer
    fs.writeFileSync(path.join(out, 'answer.json'), gemini.stdout);
    if (gemini.status === 53) throw new Error(`Gemini CLI used all ${MAX_TURNS} turns without an answer (exit 53): no review was written. Its session log: ${path.join(out, 'session.jsonl')}`);
    let result = {};
    try {
      result = JSON.parse(gemini.stdout.slice(gemini.stdout.indexOf('{')));
    } catch {
      // Not Gemini CLI's JSON: the exit code and stderr say why
    }
    if (gemini.status !== 0) throw new Error(`Gemini CLI stopped (exit ${gemini.status}): ${result.error?.message ?? gemini.stderr.slice(-2000)}`);
    const answer = answerOf(result.response);
    const usage = usageOf(result.stats);
    const review = { head, base, summary: answer.summary, findings: findingsOf(answer, diff), usage };
    const markdown = reviewOf({ answer: review, diff, headSha: head, baseSha: base, usage, inline: false }).body;

    fs.writeFileSync(path.join(out, 'diff.patch'), diff);
    fs.writeFileSync(path.join(out, 'review.json'), `${JSON.stringify(review, null, 2)}\n`);
    fs.writeFileSync(path.join(out, 'review.md'), `${markdown}\n`);
    console.log(`${markdown.split('\n')[1]}\nThe review: ${path.join(out, 'review.md')}\nIts findings: ${path.join(out, 'review.json')}`);
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
  const { head, base, summary, findings, usage } = JSON.parse(fs.readFileSync(path.join(folder, 'review.json'), 'utf8'));
  const diff = fs.readFileSync(path.join(folder, 'diff.patch'), 'utf8');
  const shown = { answer: { summary, findings }, diff, headSha: sha(head, 'head'), baseSha: sha(base, 'base'), usage };
  if (process.env.PR) {
    const url = `/repos/${repo}/pulls/${Number(process.env.PR)}/reviews`;
    try {
      await github('POST', url, reviewOf(shown));
    } catch (error) {
      // 422: GitHub can't place a line comment (a line outside the PR's own diff); the summary takes them all
      if (error.status !== 422) throw error;
      console.error(`${error.message}\nPosting every finding in the summary instead.`);
      await github('POST', url, reviewOf({ ...shown, inline: false }));
    }
  }
  // The job summary: every finding, with or without a PR
  console.log(reviewOf({ ...shown, inline: false }).body);
}

const [command, ...args] = process.argv.slice(2);
const commands = { request, run, post };
if (!commands[command]) {
  console.error('Usage: npm run review -- <commit A>..<commit B> | node test/ci-review.js request | post <folder>');
  process.exitCode = 2;
} else {
  commands[command](...args).catch((error) => {
    // One plain line, here and in the run's job summary: a review that didn't happen never passes, and never shows as a crash
    console.error(error.message);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `**AI review: not done.** ${error.message}
`);
    process.exitCode = 1;
  });
}
