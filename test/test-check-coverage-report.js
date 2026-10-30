/**
 * The coverage report's check (check-coverage-report.js): it counts the product
 * code only (src/, the install scripts, the vendored telemetry contract without
 * its tests), never test/ (the tests and the tooling there, which have tests of
 * their own), the build or node_modules; .c8rc.json includes nothing under test/;
 * a .ts file that compiles to no JavaScript (types only) isn't counted, and
 * .c8rc.json excludes exactly those; and the check fails a report that misses a
 * counted file or has any other. It runs the check on made-up reports in a
 * temporary folder.
 */
import assert from 'assert';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import * as report from './check-coverage-report.js';
import { countedFiles, INSTALL_SCRIPTS, isCounted } from './check-coverage-report.js';
import { ROOT } from './helpers/node-test-runner.js';
import { runIfMain } from './helpers/run-if-main.js';
import { createTempDir } from './helpers/test-env.js';

const entry = { lines: { covered: 0, total: 1 }, statements: { covered: 0, total: 1 }, branches: { covered: 0, total: 0 }, functions: { covered: 0, total: 0 } };

export default async function run() {
  for (const file of ['src/tools/edit.ts', 'src/remote-device/scripts/x.js', 'setup-claude-server.js', 'vendor/telemetry-contract/transport.js']) {
    assert.ok(isCounted(file), `${file} is counted`);
  }
  for (const file of ['dist/index.js', 'node_modules/c8/index.js', 'src/node_modules/x/index.js', 'src/types.d.ts', 'vendor/telemetry-contract/transport.test.js',
    'test/test-ci-platforms.js', 'test/helpers/run-if-main.js', 'scripts/build.js',
    'test/run-ci.js', 'test/run-coverage.js', 'test/check-coverage-report.js', 'test/helpers/node-test-runner.js']) {
    assert.ok(!isCounted(file), `${file} isn't counted`);
  }
  console.log('✓ what the report counts (the product code), and what it doesn\'t (test/, the build)');

  // test/ leaves the number: .c8rc.json includes nothing there, and no counted file is there
  const c8rc = JSON.parse(fs.readFileSync(path.join(ROOT, '.c8rc.json'), 'utf8'));
  assert.deepStrictEqual(c8rc.include.filter((pattern) => pattern.startsWith('test/')), [], '.c8rc.json includes nothing under test/');
  const counted = countedFiles();
  assert.deepStrictEqual(counted.filter((file) => file.startsWith('test/')), [], 'no counted file is under test/');
  for (const file of [...INSTALL_SCRIPTS, 'src/index.ts', 'vendor/telemetry-contract/transport.js']) {
    assert.ok(counted.includes(file), `${file} is among the counted files`);
  }
  assert.ok(counted.every(isCounted), 'every counted file passes isCounted');
  console.log('✓ test/ is out of the number: .c8rc.json includes nothing there');

  // A file of types only compiles to nothing a test could run: not counted, and .c8rc.json excludes it
  assert.strictEqual(typeof report.isTypeOnly, 'function', 'check-coverage-report.js tells a type-only file');
  const typesOnly = [
    'export interface A { x: number }\n',
    'import type { B } from \'./b.js\';\nexport type C = B;\n',
    'declare global {\n  var x: number | undefined;\n}\nexport {};\n',
    'import { X } from \'./x.js\';\n// a note\nexport type Y = X;\n',
  ];
  for (const source of typesOnly) assert.ok(report.isTypeOnly(source), `types only: ${JSON.stringify(source)}`);
  const withCode = [
    'export const x = 1;\n',
    'export enum E { A }\n',
    'export function f() {}\n',
    'import \'./side-effect.js\';\nexport type Y = string;\n',
  ];
  for (const source of withCode) assert.ok(!report.isTypeOnly(source), `has code: ${JSON.stringify(source)}`);
  const typeOnly = report.typeOnlyFiles();
  assert.ok(typeOnly.includes('src/types.ts'), 'src/types.ts is types only');
  const excluded = c8rc.exclude.filter((pattern) => pattern.startsWith('src/') && !pattern.includes('*'));
  assert.deepStrictEqual([...excluded].sort(), [...typeOnly].sort(), '.c8rc.json excludes exactly the type-only files');
  for (const file of typeOnly) {
    assert.ok(!isCounted(file) && !counted.includes(file), `${file} isn't counted`);
  }
  console.log('✓ a type-only file isn\'t counted, and .c8rc.json excludes exactly those');

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
    const missing = check('missing', counted.filter((file) => file !== 'src/index.ts'));
    assert.ok(missing.status === 1 && missing.output.includes('src/index.ts'), `a report without src/index.ts fails and names it:\n${missing.output}`);
    for (const extra of ['dist/index.js', 'node_modules/c8/index.js', 'test/test-ci-platforms.js', 'test/run-ci.js']) {
      const withExtra = check('extra', [...counted, extra]);
      assert.strictEqual(withExtra.status, 1, `a report with ${extra} fails:\n${withExtra.output}`);
    }
    console.log('✓ the check fails a report that misses a counted file or has any other');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

runIfMain(import.meta.url, run);
