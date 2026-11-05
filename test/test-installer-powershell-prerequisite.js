import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempDir } from './helpers/test-env.js';

test('PowerShell installer tests record missing PowerShell without failing the suite', () => {
  const files = [
    'docker-installer-claude-folders.test.js',
    'docker-installer-executable-discovery.test.js',
    'docker-installer-literal-folders.test.js',
    'docker-installer-registry-literal.test.js',
  ];
  const out = createTempDir('dc-installer-prerequisite-');
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => name.toLowerCase() !== 'path'
      && !['DC_TEST_HOME_SET', 'DC_TEST_SKIP_FILE'].includes(name)));
  env.PATH = '';
  try {
    const run = spawnSync(process.execPath, ['test/run-all-tests.js', '--no-build', '--out', out, ...files], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), env, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const result = JSON.parse(readFileSync(path.join(out, 'results.json'), 'utf8'));
    assert.equal(result.summary.files, files.length);
    assert.equal(result.summary.failed, 0);
    assert.equal(result.summary.skippedChecks, files.length);
    for (const file of files) {
      const actual = result.files.find((entry) => entry.file === `./${file}`);
      assert.ok(actual?.success, file);
      assert.equal(actual.skipped.length, 1, file);
      assert.match(actual.skipped[0], /no PowerShell/i);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
