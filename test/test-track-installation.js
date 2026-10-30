/**
 * The postinstall tracking (track-installation.js): it tells where the package
 * was installed from (Smithery, npx, npm install, Codespaces, VS Code, Gitpod, CI,
 * Docker, or unknown) from npm's variables, the environment and the parent
 * process, and posts one event with Desktop Commander's client id, to the proxy
 * or else its fallback; nothing in it fails the install. Through
 * helpers/install-script.js: stand-ins answer the post and the `ps` it runs.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { runInstallScript } from './helpers/install-script.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

const CALLS = 'test/fixtures/track-installation-calls.js';
const PROXY = 'https://telemetry.desktopcommander.app/mp/collect';
// What it reads, left out so each run sets only what it tests
const CLEAN = Object.fromEntries([
  'npm_config_user_agent', 'npm_execpath', 'npm_command', 'npm_lifecycle_event', 'npm_version',
  'CODESPACES', 'CODESPACE_NAME', 'VSCODE_PID', 'TERM_PROGRAM', 'GITPOD_WORKSPACE_ID',
  'CI', 'GITHUB_ACTIONS', 'GITHUB_REPOSITORY', 'GITHUB_WORKFLOW', 'GITLAB_CI', 'CI_PROJECT_NAME', 'JENKINS_URL',
  'JOB_NAME', 'DOCKER_CONTAINER', 'DEBUG', 'NODE_ENV', 'DC_DEBUG',
].map((name) => [name, null]));
const PARENT = { 'ps -p': { stdout: 'npm install @wonderwhy-er/desktop-commander' } };

const track = (options = {}) => runInstallScript(CALLS, {
  platform: 'linux', commands: PARENT, ...options, env: { ...CLEAN, ...options.env },
});
const sourceOf = (run) => JSON.parse(run.stdout.split('\n').find((line) => line.startsWith('{')));
const ownConfig = (config) => (home) => {
  fs.mkdirSync(path.join(home, '.claude-server-commander'), { recursive: true });
  const text = typeof config === 'string' ? config : JSON.stringify(config);
  fs.writeFileSync(path.join(home, '.claude-server-commander', 'config.json'), text);
};

async function sources() {
  // /.dockerenv as told (the fs stand-in), so the machine this runs on doesn't decide
  const outside = { dockerenv: false };
  const cases = [
    [{ env: { npm_config_user_agent: 'smithery/1.0 npm/10' } }, 'smithery'],
    [{ commands: { 'ps -p': { stdout: 'node /x/@smithery/cli/run.js' } } }, 'smithery'],
    [{ env: { npm_command: 'exec' } }, 'npx-direct'],
    [{ args: ['npx'] }, 'npx-direct'],
    [{ env: { npm_command: 'install' } }, 'npm-install'],
    [{ env: { npm_lifecycle_event: 'postinstall' } }, 'npm-install'],
    [{ env: { CODESPACES: 'true', CODESPACE_NAME: 'cs' } }, 'github-codespaces'],
    [{ env: { CODESPACES: 'true' } }, 'github-codespaces'],
    [{ env: { VSCODE_PID: '1' } }, 'vscode'],
    [{ env: { TERM_PROGRAM: 'vscode' } }, 'vscode'],
    [{ env: { GITPOD_WORKSPACE_ID: 'abcdefghijkl' } }, 'gitpod'],
    [{ env: { CI: 'true', GITHUB_ACTIONS: 'true' } }, 'github-actions'],
    [{ env: { CI: 'true', GITLAB_CI: 'true' } }, 'gitlab-ci'],
    [{ env: { CI: 'true', JENKINS_URL: 'https://ci' } }, 'jenkins'],
    [{ env: { CI: 'true' } }, 'ci-cd-other'],
    [{ env: { DOCKER_CONTAINER: '1', HOSTNAME: 'abcdef123456' } }, 'docker'],
    [{ env: { HOSTNAME: 'abcdef123456' }, fs: { dockerenv: true } }, 'docker'],
    [{ fs: outside }, 'unknown'],
    [{ commands: { 'ps -p': { error: 'no ps' } }, fs: outside }, 'unknown'],
    [{ platform: 'win32', fs: outside }, 'unknown'],
  ];
  for (const [options, source] of cases) {
    const run = await track(options);
    assert.strictEqual(run.code, 0, run.stderr);
    assert.strictEqual(sourceOf(run).source, source, JSON.stringify(options));
  }
  const gitpod = sourceOf(await track({ env: { GITPOD_WORKSPACE_ID: 'abcdefghijkl' } }));
  assert.strictEqual(gitpod.details.workspace_id, 'abcdefgh...', 'the Gitpod workspace cut short');
  const container = sourceOf(await track({ env: { HOSTNAME: 'abcdef123456' }, fs: { dockerenv: true } }));
  assert.strictEqual(container.details.container_id, 'abcdef12...', 'the container cut short');
  const smithery = { env: { npm_config_user_agent: 'smithery' }, commands: { 'ps -p': { error: 'no ps' } } };
  assert.strictEqual(sourceOf(await track(smithery)).details.parent_process, 'unknown', 'no parent process read');
  console.log('✓ where it was installed from: npm\'s variables, the environment, the parent process');
}

async function posts() {
  const run = await track({ prepare: ownConfig({ clientId: 'mine' }) });
  assert.deepStrictEqual(run.posts.map((post) => post.post), [PROXY], 'one post, to the proxy');
  const body = JSON.parse(run.posts[0].body);
  assert.strictEqual(body.client_id, 'mine', 'Desktop Commander\'s client id');
  assert.strictEqual(body.events[0].name, 'package_installed');
  for (const config of [{ telemetryEnabled: true }, '{ not json', undefined]) {
    const other = await track({ prepare: config === undefined ? undefined : ownConfig(config) });
    assert.match(JSON.parse(other.posts[0].body).client_id, /^[0-9a-f-]{36}$/, `a new id: ${config}`);
  }
  for (const answer of ['error', 'status', 'hang', 'response-error', 'close']) {
    const refused = await track({ telemetry: { byEvent: { package_installed: [answer, 'ok'] } } });
    assert.strictEqual(refused.code, 0, `${answer}: the install goes on`);
    assert.strictEqual(refused.posts.length, 2, `${answer}: the proxy, then the fallback`);
    assert.notStrictEqual(refused.posts[1].post, PROXY);
  }
  console.log('✓ one post with Desktop Commander\'s client id, or a new one; the fallback when the proxy refuses');
}

async function debugOutput() {
  const debugging = [{ DEBUG: 'desktop-commander' }, { DEBUG: '*' }, { NODE_ENV: 'development' }, { DC_DEBUG: 'true' }];
  for (const env of debugging) {
    const run = await track({ env, prepare: ownConfig('{ not json'), commands: { 'ps -p': { error: 'no ps' } } });
    const says = (text) => run.stdout.includes(text);
    assert.ok(says('[Desktop Commander] Installation tracked'), `${JSON.stringify(env)}:\n${run.stdout}`);
    assert.ok(says('Could not get parent process info') && says('Error reading config file'), run.stdout);
  }
  const quiet = await track();
  assert.ok(!quiet.stdout.includes('[Desktop Commander]'), 'quiet without DEBUG');
  console.log('✓ DEBUG, NODE_ENV=development or DC_DEBUG: it says what it found; otherwise quiet');
}

async function postinstall() {
  // npm runs `node dist/track-installation.js`: started directly, it tracks once. On Windows it doesn't yet: it
  // compares its file: URL with `file://` and the path, which never match there (file:///C:/… against file://C:\…)
  const run = await runInstallScript('dist/track-installation.js', { platform: 'linux', commands: PARENT, env: CLEAN });
  assert.strictEqual(run.code, 0, run.stderr);
  if (process.platform === 'win32') {
    return skip('track-installation.js: on Windows main() never runs (its started-directly check never matches), '
      + 'so postinstall tracks nothing (a product bug, its own fix PR)');
  }
  assert.deepStrictEqual(run.posts.map((post) => post.event), ['package_installed'], 'postinstall tracks once');
  console.log('✓ postinstall: started directly, it tracks once');
  return undefined;
}

export default async function run() {
  await sources();
  await posts();
  await debugOutput();
  await postinstall();
}

runIfMain(import.meta.url, run);
