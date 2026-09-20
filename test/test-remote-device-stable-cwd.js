import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopCommanderIntegration } from '../dist/remote-device/desktop-commander-integration.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..');
const transientCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-commander-cwd-'));

process.chdir(transientCwd);
if (process.platform !== 'win32') {
  fs.rmSync(transientCwd, { recursive: true, force: true });
}

const integration = new DesktopCommanderIntegration();
let config;
try {
  config = await integration.resolveMcpConfig();
} finally {
  process.chdir(repoRoot);
  fs.rmSync(transientCwd, { recursive: true, force: true });
}

assert.ok(config, 'expected local Desktop Commander MCP config');assert.equal(config.command, process.execPath, 'local config should use current Node executable');
assert.deepEqual(config.args, [path.join(repoRoot, 'dist', 'index.js')]);
assert.equal(
  config.cwd,
  os.homedir(),
  'local MCP child should use the durable user home instead of launcher cwd'
);
assert.notEqual(
  config.cwd,
  path.dirname(config.args[0]),
  'package replacement must not orphan the child cwd'
);

console.log('PASS: remote-device local MCP config uses durable home cwd');