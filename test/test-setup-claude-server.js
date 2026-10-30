/**
 * The setup script (setup-claude-server.js, `npm run setup` and the `setup` bin):
 * it writes Desktop Commander into Claude's config for each platform, keeps what
 * else the config has, sets the server up for npx or the local checkout, with or
 * without the debugger, restarts Claude, and fails with exit 1 on a config it can't
 * read or write. Through helpers/install-script.js: a temporary home, and stand-ins
 * for telemetry and for the commands that stop and start Claude.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { runInstallScript } from './helpers/install-script.js';
import { ROOT } from './helpers/node-test-runner.js';
import { runIfMain } from './helpers/run-if-main.js';

const SCRIPT = 'setup-claude-server.js';
// Where each platform keeps Claude's config, in the home
const CLAUDE_CONFIG = {
  linux: '.config/Claude/claude_desktop_config.json',
  darwin: 'Library/Application Support/Claude/claude_desktop_config.json',
  win32: 'AppData/Roaming/Claude/claude_desktop_config.json',
  freebsd: '.claude_desktop_config.json',
};
const ANSWERED = {
  'npm --version': { stdout: '10.9.0' },
  pkill: { stdout: '' },
  killall: { stdout: '' },
  taskkill: { stdout: '' },
  open: { stdout: '' },
  claude: { stdout: '' },
};
// The local checkout's server, as the script writes it
const LOCAL_INDEX = path.join(ROOT, 'dist', 'index.js').replace(/\\/g, '\\\\');
// npm's own variables left out (npm run test:coverage sets them), so each run says how it was started
const NPM_VARIABLES = ['npm_lifecycle_event', 'npm_execpath', '_', 'npm_package_version', 'npm_lifecycle_script'];
const NO_NPX = Object.fromEntries(NPM_VARIABLES.map((name) => [name, null]));

const events = (run) => run.posts.map((post) => post.event);
const sent = (run, ...names) => names.every((name) => events(run).includes(name));
const claudeConfig = (run, platform) => JSON.parse(run.home[CLAUDE_CONFIG[platform]]);
const ownConfig = (run) => JSON.parse(run.home['.claude-server-commander/config.json']);
const setup = (options = {}) => runInstallScript(SCRIPT, {
  commands: ANSWERED, ...options, env: { ...NO_NPX, ...options.env },
});
/** Writes a file in the home, its folders too */
const put = (home, file, text) => {
  fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true });
  fs.writeFileSync(path.join(home, file), text);
};

async function eachPlatform() {
  const shells = { linux: '/bin/sh', darwin: '/bin/sh', win32: 'cmd.exe', freebsd: '/bin/sh' };
  const commands = {
    linux: ['npm --version', 'pkill -f "claude"', 'claude'],
    darwin: ['npm --version', 'killall "Claude"', 'open -a "Claude"'],
    win32: ['npm --version', 'cmd.exe /c taskkill /F /IM "Claude.exe"'],
    freebsd: ['npm --version'],
  };
  for (const platform of ['linux', 'darwin', 'win32', 'freebsd']) {
    const run = await setup({ platform });
    assert.strictEqual(run.code, 0, `${platform}: ${run.stderr}`);
    const config = claudeConfig(run, platform);
    assert.strictEqual(config.serverConfig.command, shells[platform], `${platform}: a new config's shell`);
    assert.deepStrictEqual(config.mcpServers, { 'desktop-commander': { command: 'node', args: [LOCAL_INDEX] } });
    assert.deepStrictEqual(run.commands, commands[platform], `${platform}: Claude stopped and started`);
    const own = ownConfig(run);
    assert.ok(own.clientId && own.blockedCommands.includes('sudo') && own.telemetryEnabled === true, 'its own, new');
    assert.strictEqual(events(run)[0], 'npx_setup_start');
    assert.strictEqual(events(run).at(-1), 'npx_setup_complete');
  }
  const windows = await setup({ platform: 'win32' });
  assert.ok(sent(windows, 'npx_setup_start_claude_skipped'), 'Windows: Claude isn\'t started again');
  const other = await setup({ platform: 'freebsd' });
  assert.ok(other.stdout.includes('restart Claude if it\'s currently running'), 'elsewhere: restart it yourself');
  console.log('✓ each platform: its config file, a new config, Claude stopped and started');
}

async function existingConfigs() {
  const servers = { desktopCommander: { command: 'old' }, other: { command: 'x' } };
  const prepare = (home) => {
    put(home, CLAUDE_CONFIG.linux, JSON.stringify({ mcpServers: servers }));
    put(home, '.claude-server-commander/config.json', JSON.stringify({ clientId: 'kept' }));
  };
  const run = await setup({ platform: 'linux', prepare });
  assert.strictEqual(run.code, 0, run.stderr);
  const names = Object.keys(claudeConfig(run, 'linux').mcpServers).sort();
  assert.deepStrictEqual(names, ['desktop-commander', 'other'], 'the old name gone, others kept');
  assert.ok(sent(run, 'npx_setup_remove_old_config', 'npx_setup_config_file_read'));
  assert.deepStrictEqual(ownConfig(run), { clientId: 'kept' }, 'its own config kept');
  const withVersion = await setup({ platform: 'linux', env: { npm_package_version: '9.9.9' } });
  assert.ok(withVersion.stdout.includes('Desktop Commander MCP v9.9.9'), 'npm\'s package version, when npm runs it');
  console.log('✓ an existing config: the old entry replaced, the rest kept');
}

async function npxAndDebug() {
  const npx = { npm_lifecycle_event: 'npx' };
  const spec = '@wonderwhy-er/desktop-commander';
  const server = async (platform, args, env = npx) => {
    const run = await setup({ platform, args, env });
    return claudeConfig(run, platform).mcpServers['desktop-commander'];
  };
  const tagged = `${spec}@alpha`;
  assert.deepStrictEqual(await server('linux', ['setup', 'alpha']), { command: 'npx', args: ['-y', tagged] }, 'a tag');
  const windowsNpx = { command: 'cmd', args: ['/c', 'npx', '-y', tagged] };
  assert.deepStrictEqual(await server('win32', ['setup', 'alpha']), windowsNpx, 'a tag on Windows');
  const npxSpec = `${spec}@0.2.18-alpha`;
  assert.deepStrictEqual((await server('linux', [npxSpec])).args, ['-y', npxSpec], 'npx\'s own spec');
  const latest = await server('linux', [], { npm_execpath: '/usr/lib/npx-cli.js' });
  assert.deepStrictEqual(latest.args, ['-y', `${spec}@latest`], 'no spec: latest');
  const debugNpx = await server('linux', ['--debug'], { _: '/usr/bin/npx' });
  const inspector = debugNpx.env.NODE_OPTIONS.includes('--inspect-brk=9229');
  assert.ok(debugNpx.command === 'npx' && inspector, 'debug through npx');
  const debugWindows = await server('win32', ['--debug'], npx);
  assert.deepStrictEqual(debugWindows.args, ['/c', 'npx', `${spec}@latest`], 'debug through npx on Windows');
  const debugLocal = await server('linux', ['--debug'], {});
  assert.deepStrictEqual(debugLocal.args, ['--inspect-brk=9229', LOCAL_INDEX], 'debug from the checkout');
  assert.strictEqual((await server('win32', ['--debug'], {})).command, 'node.exe');
  console.log('✓ npx with a tag, npx\'s own spec or latest, and the debugger, from npx or the checkout');
}

async function restartFails() {
  const answering = (command, answer) => setup({ platform: 'linux', commands: { ...ANSWERED, [command]: answer } });
  const notRunning = await answering('pkill', { error: 'no process' });
  assert.strictEqual(notRunning.code, 0, notRunning.stderr);
  assert.ok(sent(notRunning, 'npx_setup_kill_claude_not_needed'), 'Claude wasn\'t running: fine');
  const noStart = await answering('claude', { error: 'not found' });
  assert.strictEqual(noStart.code, 0, noStart.stderr);
  assert.ok(sent(noStart, 'npx_setup_start_claude_error', 'npx_setup_restart_claude_error'));
  assert.ok(noStart.stdout.includes('Please restart it manually'), 'Claude didn\'t start: restart it yourself');
  console.log('✓ Claude not running, or not starting again: setup still succeeds and says so');
}

async function configErrors() {
  const failed = async (prepare, event) => {
    const run = await setup({ platform: 'linux', prepare });
    assert.strictEqual(run.code, 1, `${event}: exit 1\n${run.stdout}`);
    assert.ok(sent(run, event, 'npx_setup_final_error'), `${event}: ${events(run)}`);
    assert.ok(`${run.stdout}${run.stderr}`.includes('Error updating Claude configuration'), `${event}: said`);
    return run;
  };
  await failed((home) => put(home, CLAUDE_CONFIG.linux, '{ not json'), 'npx_setup_config_file_read_error');
  await failed((home) => put(home, '.config', 'a file, not a folder'), 'npx_setup_create_config_dir_error');
  await failed((home) => put(home, '.config/Claude', 'a file, not a folder'), 'npx_setup_config_file_create_error');
  const readOnly = (home) => {
    put(home, CLAUDE_CONFIG.linux, '{}');
    fs.chmodSync(path.join(home, CLAUDE_CONFIG.linux), 0o444);
  };
  await failed(readOnly, 'npx_setup_update_config_error');
  // Its own config can't be written: setup says so and goes on
  const noOwn = await setup({ platform: 'linux', prepare: (home) => put(home, '.claude-server-commander', 'a file') });
  assert.strictEqual(noOwn.code, 0, noOwn.stderr);
  assert.ok(noOwn.stderr.includes('Failed to initialize config'), noOwn.stderr);
  console.log('✓ a config it can\'t read or write: exit 1, said; its own config: said, and on it goes');
}

export default async function run() {
  await eachPlatform();
  await existingConfigs();
  await npxAndDebug();
  await restartFails();
  await configErrors();
}

runIfMain(import.meta.url, run);
