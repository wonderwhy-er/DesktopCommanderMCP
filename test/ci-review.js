/** Frozen-head code review and text checks through Claude Code. See .github/review-api.md. */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { isCounted } from './check-coverage-report.js';
import { reviewFor } from './helpers/ci-platforms.js';
import {
  answerOf,
  filesOf,
  findingsOf,
  localTestsOf,
  promptOf,
  reviewOf,
  testsOf,
  textAnswerOf,
  textCheckOf,
  textPromptOf,
  uncoveredOf,
  usageOf,
  withUncovered,
} from './helpers/ci-review.js';
import { githubApi } from './helpers/github-api.js';
import { verifyPriorRun, stagePriorRun, sourceEvidenceOf } from './helpers/review-source.js';
import {
  MAX_REVIEW_CONTEXT_BYTES, reviewContextOf, contextReceiptOf, publishedContextOf, measurementTestsOf, reviewFilesOf,
} from './helpers/review-context.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { GITHUB_REPOSITORY: repo, GH_TOKEN: token } = process.env;
const github = githubApi({ api: process.env.GITHUB_API_URL ?? 'https://api.github.com', token });
const TOOL_CALLS = 8;
const TEXT_TOOL_CALLS = 16;
const MAX_TURNS = 20;
const CHARS_PER_TOKEN = 3;
const MAX_PROMPT_TOKENS = Number(process.env.REVIEW_MAX_PROMPT_TOKENS) || 800_000;
const TIMEOUT_MS = Number(process.env.REVIEW_TIMEOUT_MS) || 12 * 60 * 1000;

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
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, ...env },
    });
    if (done.status !== 0) throw new Error(`git ${args.join(' ')}: ${done.stderr || done.error?.message}`);
    return done.stdout;
  };
  const base = git(['rev-parse', '--verify', '--end-of-options', `${from}^{commit}`]).trim();
  const head = git(['rev-parse', '--verify', '--end-of-options', `${to}^{commit}`]).trim();
  // The checkout's own diff settings (external diff, textconv) stay off
  const diff = git(['diff', '--no-color', '--no-ext-diff', '--no-textconv', `${base}...${head}`]);
  const commits = git(['log', '--reverse', '--format=%h %s', `${base}..${head}`])
    .split(/\r?\n/)
    .filter(Boolean);
  return { git, base, head, diff, commits };
}

/** The prompt: a text check's (with --text), or the review's */
function promptFor({ change: { head, base, diff, commits }, pull, tests, text, results, context }) {
  const read = (file) => fs.readFileSync(path.join(ROOT, '.github', file), 'utf8');
  const shared = {
    style: read('writing-style.md'),
    headSha: head,
    baseSha: base,
    commits,
    diff,
    files: filesOf(diff),
    tests,
    context,
  };
  if (text) {
    return textPromptOf({
      ...shared,
      template: read('text-check-prompt.md'),
      file: text.file,
      text: text.text,
      results,
      calls: TEXT_TOOL_CALLS,
    });
  }
  return promptOf({
    ...shared,
    template: read('review-prompt.md'),
    title: pull.title,
    description: pull.body,
    calls: TOOL_CALLS,
  });
}

/** Stops before any request when the prompt leaves the model's window no room for its reads and its answer */
function fitsTheWindow(prompt, diff) {
  const tokens = Math.ceil(prompt.length / CHARS_PER_TOKEN);
  if (tokens <= MAX_PROMPT_TOKENS) return;
  const about = `the prompt is about ${tokens.toLocaleString('en-US')} tokens (${diff.split('\n').length} diff lines)`;
  const limit = MAX_PROMPT_TOKENS.toLocaleString('en-US');
  throw new Error(
    `Too big to review: ${about}, over the ${limit} the model's window leaves for it. ` +
      'Review it in parts: npm run review -- A..B for each.',
  );
}

/** A text check's output: text-check.md and text-check.json, and on GitHub the job summary (it posts nothing) */
function writeTextCheck({ modelJson, change: { head, base }, text, out, context }) {
  const answer = textAnswerOf(modelJson.response);
  const markdown = textCheckOf({ answer, file: text.file, headSha: head });
  const { summary, findings, checked } = answer;
  const check = { head, base, file: text.file, summary, findings, checked, usage: usageOf(modelJson.stats),
    ...(context ? { context } : {}) };
  fs.writeFileSync(path.join(out, 'text-check.json'), `${JSON.stringify(check, null, 2)}\n`);
  fs.writeFileSync(path.join(out, 'text-check.md'), `${markdown}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  console.log(`${markdown.split('\n')[1]}\nThe text check: ${path.join(out, 'text-check.md')}`);
}

/** A review's output: review.json, with every finding by its file and line, and review.md */
function writeReview({ modelJson, change: { head, base, diff }, tests, out, context }) {
  const answer = answerOf(modelJson.response);
  const usage = usageOf(modelJson.stats);
  const findings = withUncovered(findingsOf(answer, diff), tests?.uncovered ?? []);
  const review = { head, base, summary: answer.summary, findings, usage, tests, ...(context ? { context } : {}) };
  const markdown = reviewOf({ answer: review, diff, headSha: head, baseSha: base, usage, inline: false, tests }).body;
  fs.writeFileSync(path.join(out, 'review.json'), `${JSON.stringify(review, null, 2)}\n`);
  fs.writeFileSync(path.join(out, 'review.md'), `${markdown}\n`);
  const where = `The review: ${path.join(out, 'review.md')}\nIts findings: ${path.join(out, 'review.json')}`;
  console.log(`${markdown.split('\n')[1]}\n${where}`);
}

function contextFor({ option, every, options, change }) {
  const contextFile = option('--context');
  if (every('--context').length > 1 ||
      (options.includes('--context') && (!contextFile || contextFile.startsWith('--')))) {
    throw new Error('Review context: --context needs one file.');
  }
  if (contextFile && process.env.REVIEW_CONTEXT_JSON) {
    throw new Error('Review context: use a file or workflow input, not both.');
  }
  if (contextFile && fs.statSync(contextFile).size > MAX_REVIEW_CONTEXT_BYTES) {
    throw new Error('Review context: input exceeds 48 KiB.');
  }
  const rawContext = contextFile ? fs.readFileSync(contextFile, 'utf8') : process.env.REVIEW_CONTEXT_JSON;
  if (contextFile && !rawContext.trim()) throw new Error('Review context: file is empty.');
  return reviewContextOf(rawContext, change);
}

function testsFor({ option, context, change }) {
  // The run's tests (CI: its artifacts, --tests) or this machine's last coverage run at B
  const testsDirectory = option('--tests') && path.resolve(option('--tests'));
  const automated = testsDirectory
    ? testsOf(testsDirectory)
    : localTestsOf({ root: ROOT, head: change.head });
  if (testsDirectory && fs.existsSync(path.join(testsDirectory, 'review-source.json'))) {
    if (!automated) throw new Error('Review source: verified prior results are missing.');
    Object.assign(automated, sourceEvidenceOf(testsDirectory, change));
  }
  const measured = measurementTestsOf(context);
  if (automated && measured) {
    throw new Error('Review context: choose current CI artifacts or selected native measurements.');
  }
  const ran = measured ?? automated;
  const tests = ran && {
    platforms: ran.platforms,
    failed: ran.failed,
    // Only files the coverage counts: the rules the coverage check holds the report to (.c8rc.json's files)
    uncovered: ran.lcovs.length ? uncoveredOf({ diff: change.diff, lcovs: ran.lcovs, counted: isCounted }) : null,
    ...(ran.provenance ? { selected: ran.selected, coverageScope: ran.coverageScope, provenance: ran.provenance } : {}),
  };
  return { tests, lcovs: ran?.provenance?.origin === 'github-actions' ? ran.lcovs : [] };
}

async function run(range, ...options) {
  // The key before anything else: without one, no work and no pass
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      'No Anthropic API key, so nothing was reviewed. On your machine, set ANTHROPIC_API_KEY; ' +
        "in CI, add the repository's CLAUDE_CODE_OAUTH_TOKEN secret.",
    );
  }
  const option = (name, fallback) => (options.includes(name) ? options[options.indexOf(name) + 1] : fallback);
  const every = (name) => options.flatMap((each, at) => (each === name ? [options[at + 1]] : []));
  const out = path.resolve(option('--out', path.join(ROOT, 'test-results', 'review')));
  // A failed retry must not leave an earlier review available for posting.
  for (const file of [
    'review.json',
    'review.md',
    'text-check.json',
    'text-check.md',
    'diff.patch',
    'answer.json',
    'session.jsonl',
    'rate-limits.json',
    'review-context.json',
    'review-context-receipt.json',
  ]) {
    fs.rmSync(path.join(out, file), { force: true });
  }
  const change = changeOf(range, option('--repo', ROOT));
  const context = contextFor({ option, every, options, change });
  const pull = process.env.PR ? await github('GET', `/repos/${repo}/pulls/${Number(process.env.PR)}`) : {};
  const { tests, lcovs } = testsFor({ option, context, change });
  // A text check (--text): each claim in a text against the change, with the results files it cites
  const text = option('--text') && textToCheck(option('--text'), pull);
  const prompt = promptFor({ change, pull, tests, text, context, results: text ? resultsOf(every('--results')) : [] });
  fitsTheWindow(prompt, change.diff);

  const { git, head, diff } = change;
  const modelJson = await askClaudeCode({
    prompt, head, git, key, out, diff, shell: Boolean(text), context, tests, lcovs,
  });
  const contextReceipt = contextReceiptOf(context, prompt);
  if (contextReceipt) {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'review-context.json'), `${JSON.stringify(context, null, 2)}\n`);
    fs.writeFileSync(path.join(out, 'review-context-receipt.json'), `${JSON.stringify(contextReceipt, null, 2)}\n`);
  }
  fs.writeFileSync(path.join(out, 'diff.patch'), diff);
  if (text) writeTextCheck({ modelJson, change, text, out, context: contextReceipt });
  else writeReview({ modelJson, change, tests, out, context: contextReceipt });
}

/** Export the requested head with symlinks as plain files; the model sees only this folder. */
async function askClaudeCode({ prompt, head, git, key, out, diff, shell, context, tests, lcovs }) {
  const { askClaude } = await import('./helpers/claude-review.js');
  const folder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-review-')));
  try {
    fs.mkdirSync(path.join(folder, 'review'));
    fs.writeFileSync(path.join(folder, 'review', 'diff.patch'), diff);
    const guide = fs.readFileSync(path.join(ROOT, '.github', 'code-style.md'), 'utf8');
    for (const [file, body] of Object.entries(reviewFilesOf({ guide, context, tests, lcovs }))) {
      fs.writeFileSync(path.join(folder, file), body);
    }
    const index = { GIT_INDEX_FILE: path.join(folder, 'index') };
    git(['read-tree', head], index);
    const prefix = `--prefix=${path.join(folder, 'pr').replace(/\\/g, '/')}/`;
    git(
      ['-c', 'core.symlinks=false', '-c', 'core.autocrlf=false', 'checkout-index', '--all', '--force', prefix],
      index,
    );
    fs.rmSync(index.GIT_INDEX_FILE);
    return await askClaude({
      prompt,
      key,
      folder,
      out,
      shell,
      cli: process.env.REVIEW_CLAUDE_CLI || "claude",
      calls: shell ? TEXT_TOOL_CALLS : TOOL_CALLS,
      maxTurns: MAX_TURNS,
      timeoutMs: TIMEOUT_MS,
      gitDir: shell ? git(['rev-parse', '--absolute-git-dir']).trim() : undefined,
      repo,
      token: shell ? token : undefined,
    });
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

function postContext(folder, saved, head, base) {
  const input = path.join(folder, 'review-context.json');
  const receiptFile = path.join(folder, 'review-context-receipt.json');
  const hasInput = fs.existsSync(input);
  const hasReceipt = fs.existsSync(receiptFile);
  if (saved.context === undefined && !hasInput && !hasReceipt) return null;
  if (saved.context === undefined || !hasInput || !hasReceipt) {
    throw new Error('Review context: supplemental artifacts are missing or undeclared.');
  }
  if ([input, receiptFile].some(file => fs.statSync(file).size > MAX_REVIEW_CONTEXT_BYTES)) {
    throw new Error('Review context: supplemental artifact exceeds 48 KiB.');
  }
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8')); } catch {
    throw new Error('Review context: saved input receipt is not valid JSON.');
  }
  return publishedContextOf({
    raw: fs.readFileSync(input, 'utf8'), receipt, saved: saved.context, head, base,
  });
}

async function post(folder) {
  const saved = JSON.parse(fs.readFileSync(path.join(folder, 'review.json'), 'utf8'));
  const { head, base, summary, findings, usage, tests } = saved;
  const headSha = sha(head, 'head'), baseSha = sha(base, 'base');
  const context = postContext(folder, saved, headSha, baseSha);
  const diff = fs.readFileSync(path.join(folder, 'diff.patch'), 'utf8');
  const shown = {
    answer: { summary, findings, ...(context ? { context } : {}) },
    diff,
    headSha,
    baseSha,
    usage,
    tests,
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

async function sourceVerify() {
  const checked = await verifyPriorRun({ raw: process.env.SOURCE_RUN_JSON, repo,
    head: process.env.HEAD_SHA, base: process.env.BASE_SHA, github });
  fs.writeFileSync('ci-source-manifest.json', `${JSON.stringify(checked, null, 2)}\n`);
  output(`run=${checked.run}\nartifacts=${[...new Set(checked.artifacts.map(a => a.id))].join(',')}`);
}

async function sourceStage() {
  stagePriorRun({ checked: JSON.parse(fs.readFileSync('ci-source-manifest.json', 'utf8')),
    downloaded: 'ci-source', out: 'ci' });
}

const [command, ...args] = process.argv.slice(2);
const commands = { request, run, post, 'source-verify': sourceVerify, 'source-stage': sourceStage };
if (!commands[command]) {
  console.error(
    'Usage: npm run review -- <commit A>..<commit B> [--context <file>] [--text <file> [--results <file>]...]' +
      ' | node test/ci-review.js request | post <folder>',
  );
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
