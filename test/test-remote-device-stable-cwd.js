import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopCommanderIntegration } from '../dist/remote-device/desktop-commander-integration.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..');
process.chdir(repoRoot);

const integration = new DesktopCommanderIntegration();
const config = await integration.resolveMcpConfig();

assert.ok(config, 'expected local Desktop Commander MCP config');
assert.equal(config.command, process.execPath, 'local config should use current Node executable');
assert.deepEqual(config.args, [path.join(repoRoot, 'dist', 'index.js')]);
assert.equal(
  config.cwd,
  repoRoot,
  'local MCP child should inherit the stable launcher cwd, not package dist bytes'
);
assert.notEqual(
  config.cwd,
  path.dirname(config.args[0]),
  'package replacement must not orphan the child cwd'
);

console.log('PASS: remote-device local MCP config uses stable launcher cwd');
