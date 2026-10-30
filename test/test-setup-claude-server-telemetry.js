/**
 * The setup script's telemetry (setup-claude-server.js): each event says the
 * shell, how setup was started, CI or not, npm's and the app's version; a post the
 * proxy refuses goes to the fallback, a failed event is tried 3 times, a request
 * that hangs is given up; an error nothing catches is reported and exits 1. A
 * failing post never fails the setup. Through helpers/install-script.js: stand-ins
 * answer the posts and commands, nothing reaches the network.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { runInstallScript } from './helpers/install-script.js';
import { ROOT } from './helpers/node-test-runner.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

const ANSWERED = { 'npm --version': { stdout: '10.9.0' }, pkill: { stdout: '' }, claude: { stdout: '' } };
// The terminal's and npm's variables left out, so each run sets only what it tests
const CLEAN = Object.fromEntries([
  'SHELL', 'TERM', 'TERM_PROGRAM', 'WT_SESSION', 'ComSpec', 'PROMPT', 'WSL_DISTRO_NAME', 'WSLENV',
  'CI', 'GITHUB_ACTIONS', 'TRAVIS', 'CIRCLECI',
  'npm_lifecycle_event', 'npm_execpath', '_', 'npm_config_global', 'npm_lifecycle_script', 'npm_package_version',
].map((name) => [name, null]));
const PROXY = 'https://telemetry.desktopcommander.app/mp/collect';

const setup = (options = {}) => runInstallScript('setup-claude-server.js', {
  platform: 'linux', commands: ANSWERED, ...options, env: { ...CLEAN, ...options.env },
});
const params = (run) => JSON.parse(run.posts[0].body).events[0].params;

async function shells() {
  const windows = [
    [{ TERM_PROGRAM: 'vscode' }, 'vscode-terminal'], [{ WT_SESSION: '1' }, 'windows-terminal'],
    [{ SHELL: 'C:/Git/bin/bash.exe' }, 'git-bash'], [{ TERM: 'xterm-256color' }, 'xterm-on-windows'],
    [{ ComSpec: 'C:/powershell.exe' }, 'powershell'], [{ PROMPT: '$P$G' }, 'cmd'],
    [{ WSL_DISTRO_NAME: 'Ubuntu' }, 'wsl-Ubuntu'], [{ WSLENV: 'x' }, 'wsl-unknown'], [{}, 'windows-unknown'],
  ];
  for (const [env, shell] of windows) {
    assert.strictEqual(params(await setup({ platform: 'win32', env })).shell, shell, JSON.stringify(env));
  }
  const unix = [
    ['/bin/bash', 'bash'], ['/bin/zsh', 'zsh'], ['/usr/bin/fish', 'fish'], ['/bin/ksh', 'ksh'], ['/bin/csh', 'csh'],
    ['/bin/dash', 'dash'], ['/opt/nu', 'other-unix-nu'],
  ];
  for (const [SHELL, shell] of unix) assert.strictEqual(params(await setup({ env: { SHELL } })).shell, shell, SHELL);
  assert.strictEqual(params(await setup({ env: { TERM_PROGRAM: 'iTerm.app' } })).shell, 'iterm.app');
  assert.strictEqual(params(await setup()).shell, 'unknown-shell');
  console.log('✓ each event names the shell, on Windows and elsewhere');
}

async function howStarted() {
  const contexts = [
    [{ npm_lifecycle_event: 'npx' }, 'npx'], [{ npm_config_global: 'true' }, 'global'],
    [{ npm_lifecycle_script: 'node setup-claude-server.js' }, 'npm_script'], [{}, 'direct'],
  ];
  for (const [env, context] of contexts) assert.strictEqual(params(await setup({ env })).execution_context, context);
  for (const CI of ['CI', 'GITHUB_ACTIONS', 'TRAVIS', 'CIRCLECI']) {
    assert.strictEqual(params(await setup({ env: { [CI]: '1' } })).is_ci, true, CI);
  }
  const first = params(await setup());
  const { is_ci: ci, npm_version: npm, platform } = first;
  assert.ok(ci === false && npm === '10.9.0' && platform === 'linux', JSON.stringify(first));
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  assert.strictEqual(first.app_version, version, 'the version from package.json');
  // The setup bin, dist/setup-claude-server.js, reads it from dist/version.js. On Windows it can't yet: it imports
  // the file by its path, which ESM refuses there (it needs a file: URL), so every Windows install says "unknown"
  const bin = { platform: 'linux', commands: ANSWERED, env: CLEAN };
  const fromDist = await runInstallScript('dist/setup-claude-server.js', bin);
  if (process.platform === 'win32') {
    skip('setup-claude-server.js: on Windows getVersion imports dist/version.js by its path, which ESM refuses; '
      + 'app_version is "unknown" (a product bug, its own fix PR)');
  } else {
    assert.strictEqual(params(fromDist).app_version, version, 'the version from dist/version.js');
  }
  const noNpm = params(await setup({ commands: { ...ANSWERED, 'npm --version': { error: 'not found' } } }));
  assert.strictEqual(noNpm.npm_version, 'unknown', 'no npm');
  const broken = params(await setup({ commands: { ...ANSWERED, 'npm --version': { throw: 'spawn failed' } } }));
  assert.ok(broken.error && !('npm_version' in broken), 'properties that can\'t be read: the error instead');
  console.log('✓ how setup was started, CI, npm\'s and the app\'s version, and what it sends when it can\'t tell');
}

async function failedPosts() {
  const fallback = await setup({ telemetry: { byEvent: { npx_setup_start: ['error', 'ok'] } } });
  const starts = fallback.posts.filter((post) => post.event === 'npx_setup_start');
  assert.deepStrictEqual(starts.map((post) => post.post), [PROXY, starts[1].post], 'the proxy, then the fallback');
  assert.notStrictEqual(starts[1].post, PROXY);
  for (const answer of ['status', 'hang', 'response-error', 'close']) {
    const run = await setup({ telemetry: { byEvent: { npx_setup_function_started: answer } } });
    assert.strictEqual(run.code, 0, `${answer}: setup still succeeds\n${run.stderr}`);
    const tries = run.posts.filter((post) => post.event === 'npx_setup_function_started');
    assert.strictEqual(tries.length, 6, `${answer}: 3 tries, each to the proxy and the fallback`);
  }
  const down = await setup({ telemetry: { default: 'error' } });
  assert.strictEqual(down.code, 0, 'no telemetry at all: setup still succeeds');
  assert.ok(down.home['.config/Claude/claude_desktop_config.json'], 'and still writes the config');
  console.log('✓ a refused post goes to the fallback; a failed event is tried 3 times; setup never fails on it');
}

async function uncaught() {
  const cases = [
    [{ uncaught: 'boom' }, 'npx_setup_uncaught_exception'],
    [{ unhandled: 'boom' }, 'npx_setup_unhandled_rejection'],
  ];
  for (const [answer, event] of cases) {
    const run = await setup({ commands: { ...ANSWERED, pkill: answer } });
    assert.strictEqual(run.code, 1, `${event}: exit 1`);
    const reported = run.posts.find((post) => post.event === event);
    assert.ok(reported && JSON.parse(reported.body).events[0].params.error.includes('boom'), `${event} reported`);
  }
  console.log('✓ an error or a rejection nothing catches: reported, exit 1');
}

async function blockedLog() {
  // setup.log can't be written (a folder in its place): setup says so on stderr and goes on
  const log = path.join(ROOT, 'setup.log');
  if (fs.existsSync(log)) return console.log('- setup.log already exists here: the blocked log isn\'t checked');
  fs.mkdirSync(log);
  try {
    const run = await setup();
    assert.strictEqual(run.code, 0, run.stderr);
    assert.ok(run.stderr.includes('Failed to write to log file'), run.stderr);
  } finally {
    fs.rmSync(log, { recursive: true, force: true });
  }
  console.log('✓ a log it can\'t write: said on stderr, and setup goes on');
}

export default async function run() {
  await shells();
  await howStarted();
  await failedPosts();
  await uncaught();
  await blockedLog();
}

runIfMain(import.meta.url, run);
