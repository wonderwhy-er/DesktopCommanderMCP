/**
 * Checks the coverage report `npm run test:coverage` wrote: it counts our source,
 * each file shown as itself, and nothing else:
 * - every file under src/ (.ts and .js);
 * - the install scripts the package ships at its root: setup-claude-server.js
 *   (bin `setup`), uninstall-claude-server.js (bin `remove`) and
 *   track-installation.js (postinstall);
 * - the vendored vendor/telemetry-contract/, without its own tests;
 * - the test tooling: the runners, coverage and CI scripts in TEST_TOOLING
 *   (.c8rc.json includes the same files), not the tests themselves.
 * It fails on:
 * - any other key: dist/ (a file shown as built, not as its source; also what a
 *   plain build during the run leaves, see test/run-ci.js), node_modules, the
 *   tests in test/, scripts/;
 * - a counted file the report doesn't list (every one is listed, a file no test
 *   runs at 0 %).
 *
 *   node test/check-coverage-report.js [coverage-summary.json [root]]
 *     default: coverage/coverage-summary.json; root: the checkout the report was
 *     made in (its keys are absolute paths), by default this one
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ROOT } from './helpers/node-test-runner.js';

export const INSTALL_SCRIPTS = ['setup-claude-server.js', 'uninstall-claude-server.js', 'track-installation.js'];
// The scripts that run, measure and report the tests: a feature of their own, with their own tests
export const TEST_TOOLING = [
  'test/check-coverage-report.js',
  'test/coverage-areas.js',
  'test/docker/run-docker-tests.js',
  'test/helpers/node-test-runner.js',
  'test/helpers/select-tests.js',
  'test/helpers/test-home.js',
  'test/integration/run-all-integration-tests.js',
  'test/map-copied-scripts.js',
  'test/repro/run-repro.js',
  'test/run-all-tests.js',
  'test/run-ci.js',
  'test/run-coverage.js',
];
const VENDORED = 'vendor/telemetry-contract';
const SOURCE = /\.(ts|tsx|js|mjs|cjs)$/;
const isTest = (file) => /\.test\.(js|mjs|cjs|ts)$/.test(file);

/** Whether a file (a path from the checkout's root) is one the report counts */
export function isCounted(file) {
  if (file.includes('node_modules/') || file.endsWith('.d.ts')) return false;
  return file.startsWith('src/') || INSTALL_SCRIPTS.includes(file) || TEST_TOOLING.includes(file)
    || (file.startsWith(`${VENDORED}/`) && !isTest(file));
}

/** Every counted source file in this checkout */
export function countedFiles() {
  const files = [...INSTALL_SCRIPTS, ...TEST_TOOLING];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const file = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else if (SOURCE.test(entry.name) && !entry.name.endsWith('.d.ts') && isCounted(file)) files.push(file);
    }
  };
  walk('src');
  walk(VENDORED);
  return files;
}

// Real paths on both sides: started through a symlink or junction, the check still runs
const isMain = process.argv[1] && fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url));
if (isMain) {
  const summaryFile = path.resolve(process.argv[2] ?? path.join(ROOT, 'coverage', 'coverage-summary.json'));
  if (!fs.existsSync(summaryFile)) {
    console.error(`✗ No coverage report: ${summaryFile} is missing`);
    process.exit(1);
  }

  // The keys are absolute paths in the checkout the report was made in: compare from its root on
  const root = (process.argv[3] ?? ROOT).split('\\').join('/').replace(/\/$/, '');
  const keys = Object.keys(JSON.parse(fs.readFileSync(summaryFile, 'utf8')))
    .filter((key) => key !== 'total')
    .map((key) => key.split('\\').join('/'))
    .map((key) => (key.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? key.slice(root.length + 1) : key));
  const outside = keys.filter((key) => !isCounted(key));
  const sources = countedFiles();
  const listed = new Set(keys);
  const missing = sources.filter((file) => !listed.has(file));

  if (outside.length > 0) {
    console.error(`✗ ${outside.length} file(s) in the coverage report aren't counted source (src/, the install scripts, ${VENDORED}/, the test tooling), e.g.:`);
    for (const key of outside.slice(0, 10)) console.error(`  ${key}`);
  }
  if (missing.length > 0) {
    console.error(`✗ ${missing.length} of ${sources.length} counted source file(s) aren't in the coverage report, e.g.:`);
    for (const file of missing.slice(0, 10)) console.error(`  ${file}`);
  }
  if (outside.length > 0 || missing.length > 0) process.exit(1);
  console.log(`✓ Coverage report: all ${sources.length} counted source files (src/, the install scripts, ${VENDORED}/, the test tooling), nothing else`);
}
