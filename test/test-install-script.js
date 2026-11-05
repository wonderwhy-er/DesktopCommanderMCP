/** Verifies that a real failed spawn rejects and removes the install harness's temporary files. */
import assert from 'assert';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as installHarness from './helpers/install-script.js';
import { runIfMain } from './helpers/run-if-main.js';
const { runInstallScript } = installHarness;

/** Permission fixtures must distinguish UID 0 from ordinary users and platforms without Unix UIDs. */
function rootUserDetection() {
  assert.strictEqual(typeof installHarness.isRoot, 'function', 'the shared root precondition exists');
  const getuid = process.getuid;
  try {
    process.getuid = () => 0;
    assert.strictEqual(installHarness.isRoot(), true, 'UID 0 bypasses chmod write denial');
    process.getuid = () => 1000;
    assert.strictEqual(installHarness.isRoot(), false, 'ordinary users retain permission assertions');
    process.getuid = undefined;
    assert.strictEqual(installHarness.isRoot(), false, 'no Unix UID is not root');
  } finally {
    if (getuid === undefined) delete process.getuid;
    else process.getuid = getuid;
  }
}

/** A missing executable emits an asynchronous error; the harness must still finish its cleanup. */
async function failedSpawnCleansTemporaryDirectories() {
  const executable = process.execPath;
  const mkdtemp = fs.mkdtempSync;
  const created = [];
  let home;
  fs.mkdtempSync = (...args) => {
    const dir = mkdtemp(...args);
    created.push(dir);
    return dir;
  };
  try {
    process.execPath = path.join(os.tmpdir(), `dc-missing-node-${randomUUID()}`);
    await assert.rejects(runInstallScript('track-installation.js', {
      prepare: (dir) => { home = dir; },
    }), { code: 'ENOENT' });
  } finally {
    process.execPath = executable;
    fs.mkdtempSync = mkdtemp;
  }
  assert.ok(home && created.length > 0, 'the harness prepared a temporary home and directories');
  for (const dir of created) assert.ok(!fs.existsSync(dir), `failed spawn removed ${dir}`);
  assert.ok(!fs.existsSync(home), 'failed spawn removed the temporary home');
  console.log('✓ failed spawn: rejected with ENOENT and all temporary directories removed');
}

export default async function run() {
  rootUserDetection();
  await failedSpawnCleansTemporaryDirectories();
}

runIfMain(import.meta.url, run);
