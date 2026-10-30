/**
 * `npm run test:coverage`'s steps (run-coverage.js): the tests under c8, then the
 * report's check, then the table per area, also when a step failed; it fails when
 * the tests or the check did. A stand-in for `node` records each step and answers
 * with an exit status; nothing runs.
 */
import assert from 'assert';
import path from 'path';
import { runCoverage } from './run-coverage.js';
import { runIfMain } from './helpers/run-if-main.js';

/** runCoverage with each step's exit status: the steps it ran, by script name, and its exit code */
function withStatuses(statuses, args = []) {
  const steps = [];
  const node = (argv) => {
    const script = argv.map((arg) => path.basename(arg)).find((name) => /\.js$/.test(name) && name !== 'c8.js') ?? '?';
    const ranUnderC8 = argv.some((arg) => path.basename(arg) === 'c8.js');
    steps.push(ranUnderC8 ? `c8 ${script} ${argv.slice(argv.findIndex((arg) => arg.endsWith(script)) + 1).join(' ')}`.trim() : script);
    return statuses[script] ?? 0;
  };
  return { code: runCoverage({ node, args }), steps };
}

export default async function run() {
  const passing = withStatuses({}, ['--changed', 'A', 'B']);
  assert.deepStrictEqual(passing.steps, ['c8 run-ci.js --changed A B', 'check-coverage-report.js', 'coverage-areas.js'],
    'the tests under c8 with the arguments given, then the check, then the areas');
  assert.strictEqual(passing.code, 0);

  const testsFail = withStatuses({ 'run-ci.js': 1 });
  assert.strictEqual(testsFail.code, 1, 'failed tests fail it');
  assert.strictEqual(testsFail.steps.length, 3, 'the check and the areas still run after failed tests');

  const checkFails = withStatuses({ 'check-coverage-report.js': 1 });
  assert.strictEqual(checkFails.code, 1, 'a failed check fails it');
  assert.strictEqual(checkFails.steps.length, 3, 'the areas still print after a failed check');

  assert.strictEqual(withStatuses({ 'coverage-areas.js': 1 }).code, 0, 'the table only reports: it fails nothing');
  console.log('✓ test:coverage: the tests under c8, the check, the areas; it fails with the tests or the check');
}

runIfMain(import.meta.url, run);
