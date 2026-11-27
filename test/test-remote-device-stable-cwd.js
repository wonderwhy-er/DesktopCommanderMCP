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

assert.ok(config, 'expected local Desktop Commander MCP config');
assert.equal(config.command, process.execPath, 'local config should use current Node executable');
assert.deepEqual(config.args, [path.join(repoRoot, 'dist', 'index.js')]);
assert.equal(config.cwd, os.homedir(), 'local MCP child should use the durable user home instead of launcher cwd');
assert.notEqual(config.cwd, path.dirname(config.args[0]), 'package replacement must not orphan the child cwd');

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const invalidHomeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-commander-invalid-home-'));
const invalidHome = path.join(invalidHomeRoot, 'home-is-a-file');
fs.writeFileSync(invalidHome, 'not a directory');
let fallbackConfig;
try {
  process.env.HOME = invalidHome;
  process.env.USERPROFILE = invalidHome;
  fallbackConfig = await integration.resolveMcpConfig();
} finally {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  fs.rmSync(invalidHomeRoot, { recursive: true, force: true });
}

assert.ok(fallbackConfig, 'expected local Desktop Commander MCP fallback config');
assert.equal(
  fallbackConfig.cwd,
  path.parse(process.execPath).root,
  'invalid home candidates should fall back to the executable filesystem root'
);

console.log('PASS: remote-device local MCP config uses durable directory cwd with root fallback');
