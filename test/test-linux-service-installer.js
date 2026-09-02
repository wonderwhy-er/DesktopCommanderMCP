import assert from 'assert';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

if (process.platform !== 'linux') {
  console.log('✓ Linux service installer tests skipped on non-Linux platform');
  process.exit(0);
}

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const script = path.join(root, 'scripts', 'install-linux-service.sh');
const binary = path.join(root, 'dist', 'index.js');
const user = typeof process.getuid === 'function' && process.getuid() === 0
  ? 'nobody'
  : os.userInfo().username;

const unit = execFileSync('bash', [
  script,
  '--dry-run',
  '--user', user,
  '--bin', binary,
  '--service', 'desktop-commander-test',
], { encoding: 'utf8' });

assert(unit.includes(`User=${user}`));
assert(unit.includes(`ExecStart="${binary}" remote --persist-session --disable-no-sleep`));
assert(unit.includes('NoNewPrivileges=true'));
assert(unit.includes('UMask=0077'));

const invalidName = spawnSync('bash', [
  script,
  '--dry-run',
  '--user', user,
  '--bin', binary,
  '--service', '../escape',
], { encoding: 'utf8' });
assert.notStrictEqual(invalidName.status, 0);
assert.match(invalidName.stderr, /Invalid service name/);

if (typeof process.getuid === 'function' && process.getuid() === 0) {
  const rootRejected = spawnSync('bash', [
    script,
    '--dry-run',
    '--user', 'root',
    '--bin', binary,
  ], { encoding: 'utf8' });
  assert.notStrictEqual(rootRejected.status, 0);
  assert.match(rootRejected.stderr, /Refusing to install a root-owned remote agent/);
}

assert(fs.existsSync(script));
console.log('✓ Linux service installer tests passed');
