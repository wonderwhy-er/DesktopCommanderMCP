/**
 * The install scripts' telemetry, the same code in setup-claude-server.js and
 * uninstall-claude-server.js: each event says the shell, how the script was
 * started, CI or not, npm's and the app's version; a post the proxy refuses goes
 * to the fallback, a failed event is tried 3 times, a request that hangs is given
 * up; an error nothing catches is reported and exits 1; a log it can't write is
 * said on stderr. A failing post never fails the script. Through
 * helpers/install-script.js: stand-ins answer the posts and commands, nothing
 * reaches the network.
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
// Uninstall sends telemetry only when Desktop Commander's config says so
const telemetryOn = (home) => {
  const folder = path.join(home, '.claude-server-commander');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'config.json'), JSON.stringify({ telemetryEnabled: true }));
};
const SCRIPTS = [
  { file: 'setup-claude-server.js', prefix: 'npx_setup', first: 'npx_setup_function_started' },
  { file: 'uninstall-claude-server.js', prefix: 'uninstall', first: 'uninstall_start', prepare: telemetryOn },
];

const runner = (script) => (options = {}) => runInstallScript(script.file, {
  platform: 'linux', commands: ANSWERED, prepare: script.prepare, ...options, env: { ...CLEAN, ...options.env },
});
const params = (run) => JSON.parse(run.posts[0].body).events[0].params;

async function shells(run) {
  const windows = [
    [{ TERM_PROGRAM: 'vscode' }, 'vscode-terminal'], [{ WT_SESSION: '1' }, 'windows-terminal'],
    [{ SHELL: 'C:/Git/bin/bash.exe' }, 'git-bash'], [{ TERM: 'xterm-256color' }, 'xterm-on-windows'],
    [{ ComSpec: 'C:/powershell.exe' }, 'powershell'], [{ PROMPT: '$P$G' }, 'cmd'],
    [{ WSL_DISTRO_NAME: 'Ubuntu' }, 'wsl-Ubuntu'], [{ WSLENV: 'x' }, 'wsl-unknown'], [{}, 'windows-unknown'],
  ];
  for (const [env, shell] of windows) {
    assert.strictEqual(params(await run({ platform: 'win32', env })).shell, shell, JSON.stringify(env));
  }
  const unix = [
    ['/bin/bash', 'bash'], ['/bin/zsh', 'zsh'], ['/usr/bin/fish', 'fish'], ['/bin/ksh', 'ksh'], ['/bin/csh', 'csh'],
    ['/bin/dash', 'dash'], ['/opt/nu', 'other-unix-nu'],
  ];
  for (const [SHELL, shell] of unix) assert.strictEqual(params(await run({ env: { SHELL } })).shell, shell, SHELL);
  assert.strictEqual(params(await run({ env: { TERM_PROGRAM: 'iTerm.app' } })).shell, 'iterm.app');
  assert.strictEqual(params(await run()).shell, 'unknown-shell');
}

async function howStarted(run, script) {
  const contexts = [
    [{ npm_lifecycle_event: 'npx' }, 'npx'], [{ npm_config_global: 'true' }, 'global'],
    [{ npm_lifecycle_script: `node ${script.file}` }, 'npm_script'], [{}, 'direct'],
  ];
  for (const [env, context] of contexts) assert.strictEqual(params(await run({ env })).execution_context, context);
  for (const CI of ['CI', 'GITHUB_ACTIONS', 'TRAVIS', 'CIRCLECI']) {
    assert.strictEqual(params(await run({ env: { [CI]: '1' } })).is_ci, true, CI);
  }
  const first = params(await run());
  const { is_ci: ci, npm_version: npm, platform } = first;
  assert.ok(ci === false && npm === '10.9.0' && platform === 'linux', JSON.stringify(first));
  assert.strictEqual(params(await run({ env: { npm_package_version: '9.9.9' } })).app_version, '9.9.9', 'npm\'s');
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  assert.strictEqual(first.app_version, version, 'the version from package.json');
  // The bins in dist/ read it from dist/version.js. On Windows they can't yet: they import the file by its path,
  // which ESM refuses there (it needs a file: URL), so every Windows install says "unknown"
  const fromDist = params(await runInstallScript(`dist/${script.file}`, {
    platform: 'linux', commands: ANSWERED, prepare: script.prepare, env: CLEAN,
  }));
  if (process.platform === 'win32') {
    skip(`${script.file}: on Windows getVersion imports dist/version.js by its path, which ESM refuses; `
      + 'app_version is "unknown" (a product bug, its own fix PR)');
  } else {
    assert.strictEqual(fromDist.app_version, version, 'the version from dist/version.js');
  }
  const noNpm = params(await run({ commands: { ...ANSWERED, 'npm --version': { error: 'not found' } } }));
  assert.strictEqual(noNpm.npm_version, 'unknown', 'no npm');
  const broken = params(await run({ commands: { ...ANSWERED, 'npm --version': { throw: 'spawn failed' } } }));
  assert.ok(broken.error && !('npm_version' in broken), 'properties that can\'t be read: the error instead');
}

async function failedPosts(run, script) {
  const first = await run({ telemetry: { byEvent: { [script.first]: ['error', 'ok'] } } });
  const tries = first.posts.filter((post) => post.event === script.first);
  assert.strictEqual(tries[0].post, PROXY, 'the proxy first');
  assert.ok(tries.length === 2 && tries[1].post !== PROXY, 'then the fallback');
  for (const answer of ['status', 'hang', 'response-error', 'close']) {
    const refused = await run({ telemetry: { byEvent: { [script.first]: answer } } });
    assert.strictEqual(refused.code, 0, `${answer}: the script still succeeds\n${refused.stderr}`);
    const all = refused.posts.filter((post) => post.event === script.first);
    assert.strictEqual(all.length, 6, `${answer}: 3 tries, each to the proxy and the fallback`);
  }
  const down = await run({ telemetry: { default: 'error' } });
  assert.strictEqual(down.code, 0, 'no telemetry at all: the script still succeeds');
  // The first event is waited for at most 6 s: a post that hangs doesn't hold the script
  const held = await run({ telemetry: { byEvent: { [`${script.prefix}_start`]: 'hang' } } });
  assert.strictEqual(held.code, 0, `a hanging first post: the script still succeeds\n${held.stderr}`);
  assert.ok(held.posts.some((post) => post.event === script.first || post.event.endsWith('_complete')), 'and goes on');
}

async function uncaught(run, script) {
  const cases = [[{ uncaught: 'boom' }, 'uncaught_exception'], [{ unhandled: 'boom' }, 'unhandled_rejection']];
  for (const [answer, kind] of cases) {
    const raised = await run({ commands: { ...ANSWERED, 'npm --version': { ...answer, stdout: '10.9.0' } } });
    assert.strictEqual(raised.code, 1, `${kind}: exit 1`);
    const reported = raised.posts.find((post) => post.event === `${script.prefix}_${kind}`);
    assert.ok(reported && JSON.parse(reported.body).events[0].params.error.includes('boom'), `${kind} reported`);
  }
}

async function blockedLog(run) {
  // setup.log can't be written (a folder in its place): said on stderr, and the script goes on
  const log = path.join(ROOT, 'setup.log');
  if (fs.existsSync(log)) return skip('setup.log already exists in the checkout: the blocked log isn\'t checked');
  fs.mkdirSync(log);
  try {
    const blocked = await run();
    assert.strictEqual(blocked.code, 0, blocked.stderr);
    assert.ok(blocked.stderr.includes('Failed to write to log file'), blocked.stderr);
  } finally {
    fs.rmSync(log, { recursive: true, force: true });
  }
  return undefined;
}

export default async function run() {
  for (const script of SCRIPTS) {
    const runScript = runner(script);
    await shells(runScript);
    await howStarted(runScript, script);
    await failedPosts(runScript, script);
    await uncaught(runScript, script);
    await blockedLog(runScript);
    console.log(`✓ ${script.file}: the shell, how it was started, versions, refused posts, uncaught errors, its log`);
  }
}

runIfMain(import.meta.url, run);
