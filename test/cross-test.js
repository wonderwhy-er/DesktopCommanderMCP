/**
 * One commit's tests on another commit's code, with coverage
 * (helpers/cross-test.js): what breaks, or loses coverage, when the tests of one
 * commit run on the code of another. Both commits need the test framework.
 *
 *   node test/cross-test.js --tests-from <commit> [--code <commit>] [--out <dir>]
 *     --code  the commit whose code runs (default HEAD)
 *     --out   where the results, the coverage and cross-test.json go
 *             (default test-results/cross)
 */
import path from 'path';
import { crossTest, readCrossArgs } from './helpers/cross-test.js';
import { ROOT } from './helpers/node-test-runner.js';

try {
  const { testsFrom, code, outDir } = readCrossArgs(process.argv.slice(2));
  process.exit(await crossTest({ root: ROOT, code, testsFrom, outDir: outDir && path.resolve(outDir) }));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
