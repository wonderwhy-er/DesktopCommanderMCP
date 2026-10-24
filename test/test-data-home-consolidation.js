/**
 * #666: Fresh installations share one Desktop Commander data folder.
 * Older credentials/logs remain readable, without moving or overwriting them.
 * Run under the test runner's isolated HOME/USERPROFILE.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getRemoteDeviceConfigPath, removeRemoteDeviceConfig } from '../dist/remote-device/device.js';
import { getDeviceLogDir } from '../dist/remote-device/diagnostics/device-log.js';
import { CONFIG_FILE, TOOL_CALL_FILE } from '../dist/config.js';
import { runIfMain } from './helpers/run-if-main.js';
import { isTestHome } from './helpers/test-env.js';

export default async function runTests() {
  assert(isTestHome(), 'run this test only through the isolated test runner');
  const home = os.homedir();
  const base = path.join(home, '.claude-server-commander');
  const device = path.join(base, 'device');
  assert.equal(CONFIG_FILE, path.join(base, 'config.json'));
  assert.equal(TOOL_CALL_FILE, path.join(base, 'claude_tool_call.log'));
  assert.equal(getRemoteDeviceConfigPath(), path.join(device, 'device.json'),
    'fresh installs must save device credentials inside the single data root');
  assert.equal(getDeviceLogDir(), device,
    'fresh installs must save remote logs beside their device credentials');

  const { fuzzySearchLogger } = await import('../dist/utils/fuzzySearchLogger.js');
  assert.equal(await fuzzySearchLogger.getLogPath(), path.join(base, 'logs', 'fuzzy-search.log'),
    'fresh installs must not create the third legacy top-level log directory');
  assert(!fs.existsSync(path.join(home, '.claude-server-commander-logs')),
    'fresh install must not create the legacy fuzzy log directory');
  assert(!fs.existsSync(path.join(home, '.desktop-commander-device')),
    'fresh install must not create the legacy remote-device directory');

  // A stale old login must not reappear after explicit logout of a new login.
  const previousSession = path.join(home, '.desktop-commander-device', 'device.json');
  const currentSession = path.join(device, 'device.json');
  fs.mkdirSync(path.dirname(previousSession), { recursive: true });
  fs.mkdirSync(path.dirname(currentSession), { recursive: true });
  fs.writeFileSync(previousSession, '{"deviceId":"old-login"}');
  fs.writeFileSync(currentSession, '{"deviceId":"new-login"}');
  await removeRemoteDeviceConfig();
  assert(!fs.existsSync(currentSession), 'logout removes new credentials');
  assert(!fs.existsSync(previousSession), 'logout must also clear an older saved login');

  const { dataDir, remoteDeviceDir, fuzzyLogPath } = await import('../dist/utils/data-paths.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-issue-666-'));
  try {
    const legacyRemote = path.join(root, '.desktop-commander-device');
    const modernRemote = path.join(dataDir(root), 'device');
    const legacyFuzzy = path.join(root, '.claude-server-commander-logs', 'fuzzy-search.log');
    const modernFuzzy = path.join(dataDir(root), 'logs', 'fuzzy-search.log');
    assert.equal(remoteDeviceDir(root), modernRemote);
    assert.equal(fuzzyLogPath(root), modernFuzzy);

    fs.mkdirSync(legacyRemote, { recursive: true });
    const credentials = '{"deviceId":"saved-legacy-device","session":{"refresh_token":"keep-me"}}';
    fs.writeFileSync(path.join(legacyRemote, 'device.json'), credentials);
    assert.equal(remoteDeviceDir(root), legacyRemote, 'preserve older saved auth sessions');

    fs.mkdirSync(modernRemote, { recursive: true });
    assert.equal(remoteDeviceDir(root), legacyRemote,
      'a new log directory must not make older credentials disappear');
    fs.writeFileSync(path.join(modernRemote, 'device.json'), '{"deviceId":"new-session"}');
    assert.equal(remoteDeviceDir(root), modernRemote, 'prefer explicit new credentials');
    assert.equal(fs.readFileSync(path.join(legacyRemote, 'device.json'), 'utf8'), credentials,
      'never delete or change old credentials');

    // A legacy install may have only log files after logout. Keep those logs
    // available even if the new data root was created in the meantime.
    fs.rmSync(path.join(modernRemote, 'device.json'));
    fs.rmSync(path.join(legacyRemote, 'device.json'));
    fs.writeFileSync(path.join(legacyRemote, 'remote-mon.log'), 'keep legacy diagnostic log');
    assert.equal(remoteDeviceDir(root), legacyRemote,
      'legacy remote logs must stay visible after a logout');

    fs.mkdirSync(path.dirname(legacyFuzzy), { recursive: true });
    fs.writeFileSync(legacyFuzzy, 'important old log entry');
    assert.equal(fuzzyLogPath(root), legacyFuzzy, 'existing fuzzy logs stay accessible');
    fs.mkdirSync(path.dirname(modernFuzzy), { recursive: true });
    fs.writeFileSync(modernFuzzy, 'new log entry');
    assert.equal(fuzzyLogPath(root), modernFuzzy, 'prefer logs already in the consolidated folder');
    assert.equal(fs.readFileSync(legacyFuzzy, 'utf8'), 'important old log entry');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  console.log('PASS: #666 one data root for new installs; legacy credentials and logs retained');
  return true;
}
runIfMain(import.meta.url, runTests);
