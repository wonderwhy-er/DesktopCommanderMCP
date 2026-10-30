/**
 * The coverage report's check (check-coverage-report.js): it counts our source,
 * the install scripts, the vendored telemetry contract without its tests, and the
 * test tooling, never the build or node_modules; .c8rc.json includes the same
 * tooling files; and the check fails a report that misses a counted file or has
 * any other. It runs the check on made-up reports in a temporary folder.
 */
import assert from 'assert';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { countedFiles, INSTALL_SCRIPTS, isCounted, TEST_TOOLING } from './check-coverage-report.js';
import { ROOT } from './helpers/node-test-runner.js';
import { runIfMain } from './helpers/run-if-main.js';
import { createTempDir } from './helpers/test-env.js';

const entry = { lines: { covered: 0, total: 1 }, statements: { covered: 0, total: 1 }, branches: { covered: 0, total: 0 }, functions: { covered: 0, total: 0 } };

export default async function run() {
  for (const file of ['src/tools/edit.ts', 'src/remote-device/scripts/x.js', 'setup-claude-server.js', 'vendor/telemetry-contract/transport.js',
    'test/run-ci.js', 'test/helpers/node-test-runner.js']) {
    assert.ok(isCounted(file), `${file} is counted`);
  }
  for (const file of ['dist/index.js', 'node_modules/c8/index.js', 'src/node_modules/x/index.js', 'src/types.d.ts', 'vendor/telemetry-contract/transport.test.js',
    'test/test-ci-platforms.js', 'test/helpers/run-if-main.js', 'scripts/build.js']) {
    assert.ok(!isCounted(file), `${file} isn't counted`);
  }
  console.log('✓ what the report counts, and what it doesn\'t');

  // The test tooling: each listed file exists, is counted, and .c8rc.json includes it
  const c8rc = JSON.parse(fs.readFileSync(path.join(ROOT, '.c8rc.json'), 'utf8'));
  for (const file of TEST_TOOLING) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} exists`);
    assert.ok(c8rc.include.includes(file), `.c8rc.json includes ${file}`);
  }
  const counted = countedFiles();
  for (const file of [...TEST_TOOLING, ...INSTALL_SCRIPTS, 'src/index.ts', 'vendor/telemetry-contract/transport.js']) {
    assert.ok(counted.includes(file), `${file} is among the counted files`);
  }
  assert.ok(counted.every(isCounted), 'every counted file passes isCounted');
  console.log('✓ the test tooling is counted, and .c8rc.json includes it');

  // The check itself, on reports made in another checkout ("/elsewhere")
  const dir = createTempDir('dc-check-coverage-report-');
  try {
    const check = (name, keys) => {
      const file = path.join(dir, `${name}.json`);
      fs.writeFileSync(file, JSON.stringify(Object.fromEntries([['total', entry], ...keys.map((key) => [`/elsewhere/${key}`, entry])])));
      const result = spawnSync(process.execPath, [path.join(ROOT, 'test', 'check-coverage-report.js'), file, '/elsewhere'], { cwd: ROOT, encoding: 'utf8' });
      return { status: result.status, output: `${result.stdout}${result.stderr}` };
    };
    const complete = check('complete', counted);
    assert.strictEqual(complete.status, 0, `a report with every counted file passes:\n${complete.output}`);
    const missing = check('missing', counted.filter((file) => file !== 'test/run-ci.js'));
    assert.ok(missing.status === 1 && missing.output.includes('test/run-ci.js'), `a report without test/run-ci.js fails and names it:\n${missing.output}`);
    for (const extra of ['dist/index.js', 'node_modules/c8/index.js', 'test/test-ci-platforms.js']) {
      const withExtra = check('extra', [...counted, extra]);
      assert.strictEqual(withExtra.status, 1, `a report with ${extra} fails:\n${withExtra.output}`);
    }
    console.log('✓ the check fails a report that misses a counted file or has any other');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

runIfMain(import.meta.url, run);
