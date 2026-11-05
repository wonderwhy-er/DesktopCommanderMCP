/** Verifies that a real failed spawn rejects and removes the install harness's temporary files. */
import assert from 'assert';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runInstallScript } from './helpers/install-script.js';
import { runIfMain } from './helpers/run-if-main.js';

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
  await failedSpawnCleansTemporaryDirectories();
}

runIfMain(import.meta.url, run);
