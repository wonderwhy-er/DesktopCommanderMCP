/**
 * The uninstall script (uninstall-claude-server.js, `npm run remove`, and the
 * `remove` bin, dist/uninstall-claude-server.js): it takes Desktop Commander out
 * of Claude's config for each platform, keeps the rest and a backup, says so when
 * there's nothing to remove, puts the backup back when it can't write the config,
 * and exits 1 then. It sends telemetry only when Desktop Commander's config allows
 * it, with that config's client id. Through helpers/install-script.js: a temporary
 * home and stand-ins.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { runInstallScript } from './helpers/install-script.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

const SCRIPT = 'uninstall-claude-server.js';
const CLAUDE_CONFIG = {
  linux: '.config/Claude/claude_desktop_config.json',
  darwin: 'Library/Application Support/Claude/claude_desktop_config.json',
  win32: 'AppData/Roaming/Claude/claude_desktop_config.json',
  freebsd: '.claude_desktop_config.json',
};
const OWN_CONFIG = '.claude-server-commander/config.json';
const SERVERS = { 'desktop-commander': { command: 'npx' }, other: { command: 'x' } };

/** Writes a file in the home, its folders too */
const put = (home, file, text) => {
  fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true });
  fs.writeFileSync(path.join(home, file), text);
};
const events = (run) => run.posts.map((post) => post.event);
const sent = (run, ...names) => names.every((name) => events(run).includes(name));
const backups = (run, platform) => Object.keys(run.home)
  .filter((file) => file.startsWith(`${CLAUDE_CONFIG[platform]}.backup.`));
const said = (run, text) => `${run.stdout}${run.stderr}`.includes(text);
const uninstall = (options = {}) => runInstallScript(SCRIPT, { platform: 'linux', ...options });
/** A home with Claude's config (text, or an object), and Desktop Commander's own config when given */
const homeWith = (claude, own, platform = 'linux') => (home) => {
  const text = typeof claude === 'string' ? claude : JSON.stringify(claude);
  if (claude !== undefined) put(home, CLAUDE_CONFIG[platform], text);
  if (own !== undefined) put(home, OWN_CONFIG, JSON.stringify(own));
};

async function eachPlatform() {
  for (const platform of Object.keys(CLAUDE_CONFIG)) {
    const run = await uninstall({ platform, prepare: homeWith({ mcpServers: SERVERS }, undefined, platform) });
    assert.strictEqual(run.code, 0, `${platform}: ${run.stderr}`);
    const config = JSON.parse(run.home[CLAUDE_CONFIG[platform]]);
    assert.deepStrictEqual(config.mcpServers, { other: { command: 'x' } }, `${platform}: removed, the rest kept`);
    const [backup] = backups(run, platform);
    assert.deepStrictEqual(JSON.parse(run.home[backup]).mcpServers, SERVERS, `${platform}: a backup of it before`);
    assert.ok(said(run, 'successfully uninstalled') && said(run, 'Telemetry disabled'), run.stdout);
    assert.deepStrictEqual(run.posts, [], 'no telemetry without its config allowing it');
  }
  console.log('✓ each platform: Desktop Commander removed from Claude\'s config, the rest kept, a backup made');
}

async function nothingToRemove() {
  const cases = [
    [undefined, 'uninstall_config_not_found'],
    [{ globalShortcut: 'x' }, 'uninstall_no_mcp_servers'],
    [{ mcpServers: { other: { command: 'x' } } }, 'uninstall_server_not_found'],
  ];
  for (const [claude, event] of cases) {
    const run = await uninstall({ prepare: homeWith(claude, { telemetryEnabled: true, clientId: 'mine' }) });
    assert.strictEqual(run.code, 0, `${event}: ${run.stderr}`);
    assert.ok(run.stdout.includes('was not configured or already removed'), `${event}: said`);
    assert.ok(sent(run, 'uninstall_start', event, 'uninstall_complete'), `${event}: ${events(run)}`);
    assert.ok(run.posts.every((post) => JSON.parse(post.body).client_id === 'mine'), 'its config\'s client id');
  }
  console.log('✓ nothing to remove (no config, no servers, not among them): said, and done');
}

async function failures() {
  const telemetry = { telemetryEnabled: true };
  const unreadable = await uninstall({ prepare: homeWith('{ not json', telemetry) });
  assert.strictEqual(unreadable.code, 1, 'a config it can\'t read: exit 1');
  assert.ok(sent(unreadable, 'uninstall_config_read_error', 'uninstall_backup_restored', 'uninstall_partial_failure'));
  assert.strictEqual(unreadable.home[CLAUDE_CONFIG.linux], '{ not json', 'the backup put back');
  assert.ok(unreadable.stdout.includes('Uninstallation completed with errors'), unreadable.stdout);

  const readOnly = (home) => {
    homeWith({ mcpServers: SERVERS }, telemetry)(home);
    fs.chmodSync(path.join(home, CLAUDE_CONFIG.linux), 0o444);
  };
  const unwritable = await uninstall({ prepare: readOnly });
  assert.strictEqual(unwritable.code, 1, 'a config it can\'t write: exit 1');
  const failed = ['uninstall_config_write_error', 'uninstall_backup_restore_failed', 'uninstall_config_error'];
  assert.ok(sent(unwritable, ...failed), events(unwritable).join(', '));
  assert.ok(said(unwritable, 'backup restoration failed'), unwritable.stdout);
  // The write fails once, as a briefly locked file does: the backup goes back, and it still exits 1
  const locked = await uninstall({
    prepare: homeWith({ mcpServers: SERVERS }, telemetry), fs: { failWriteOnce: 'claude_desktop_config.json' },
  });
  assert.strictEqual(locked.code, 1, 'a write that failed: exit 1');
  assert.ok(sent(locked, 'uninstall_config_write_error', 'uninstall_backup_restored'), events(locked).join(', '));
  assert.ok(said(locked, 'but backup was restored'), locked.stdout);
  assert.deepStrictEqual(JSON.parse(locked.home[CLAUDE_CONFIG.linux]).mcpServers, SERVERS, 'the config as it was');
  console.log('✓ a config it can\'t read or write: the backup put back when it can, exit 1');
}

async function noBackup() {
  // A folder it can't write in: no backup, and on it goes (Windows can't make a folder read-only)
  if (process.platform === 'win32') return skip('Windows can\'t make a folder read-only: no failed backup checked');
  const lockFolder = (home) => fs.chmodSync(path.dirname(path.join(home, CLAUDE_CONFIG.linux)), 0o555);
  const prepare = (home) => {
    homeWith({ mcpServers: SERVERS }, { telemetryEnabled: true })(home);
    lockFolder(home);
  };
  const run = await uninstall({ prepare });
  assert.strictEqual(run.code, 0, run.stderr);
  assert.ok(sent(run, 'uninstall_backup_failed', 'uninstall_config_updated'), events(run).join(', '));
  const neither = await uninstall({
    prepare: (home) => {
      prepare(home);
      fs.chmodSync(path.join(home, CLAUDE_CONFIG.linux), 0o444);
    },
  });
  assert.strictEqual(neither.code, 1, 'no backup and a config it can\'t write: exit 1');
  assert.ok(said(neither, 'Failed to write updated config:'), neither.stdout);
  console.log('✓ no backup possible: the config is still updated; with it unwritable too, exit 1');
  return undefined;
}

async function ownConfig() {
  // Its own config without a client id, or unreadable: telemetry stays as the config says, off when unreadable
  const noId = await uninstall({ prepare: homeWith({ mcpServers: SERVERS }, { telemetryEnabled: true }) });
  const clientId = JSON.parse(noId.posts[0].body).client_id;
  assert.match(clientId, /^[0-9a-f-]{36}$/, 'a new client id when its config has none');
  const unreadable = await uninstall({
    prepare: (home) => {
      homeWith({ mcpServers: SERVERS })(home);
      put(home, OWN_CONFIG, '{ not json');
    },
  });
  assert.strictEqual(unreadable.code, 0, unreadable.stderr);
  assert.ok(said(unreadable, 'Telemetry disabled') && unreadable.posts.length === 0, 'unreadable: telemetry off');
  console.log('✓ its own config: a new client id when it has none, telemetry off when it can\'t be read');
}

export default async function run() {
  await eachPlatform();
  await nothingToRemove();
  await failures();
  await noBackup();
  await ownConfig();
}

runIfMain(import.meta.url, run);
