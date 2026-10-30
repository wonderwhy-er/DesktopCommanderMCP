/**
 * Checks the coverage report `npm run test:coverage` wrote: it counts the product
 * code, each file shown as itself, and nothing else:
 * - every file under src/ (.ts and .js);
 * - the install scripts the package ships at its root: setup-claude-server.js
 *   (bin `setup`), uninstall-claude-server.js (bin `remove`) and
 *   track-installation.js (postinstall);
 * - the vendored vendor/telemetry-contract/, without its own tests.
 * Not a .ts file of types only: it compiles to no JavaScript, so no test can run
 * it. .c8rc.json excludes exactly those, which the check confirms.
 * It fails on:
 * - any other key: dist/ (a file shown as built, not as its source; also what a
 *   plain build during the run leaves, see test/run-ci.js), node_modules, test/
 *   (the tests, and the runners, coverage and CI scripts there, which have tests
 *   of their own), scripts/;
 * - a counted file the report doesn't list (every one is listed, a file no test
 *   runs at 0 %);
 * - a type-only file .c8rc.json doesn't exclude, or an excluded file with code.
 *
 *   node test/check-coverage-report.js [coverage-summary.json [root]]
 *     default: coverage/coverage-summary.json; root: the checkout the report was
 *     made in (its keys are absolute paths), by default this one
 */
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { ROOT } from './helpers/node-test-runner.js';

export const INSTALL_SCRIPTS = ['setup-claude-server.js', 'uninstall-claude-server.js', 'track-installation.js'];
const VENDORED = 'vendor/telemetry-contract';
const SOURCE = /\.(ts|tsx|js|mjs|cjs)$/;
const isTest = (file) => /\.test\.(js|mjs|cjs|ts)$/.test(file);
const require = createRequire(import.meta.url);

/** Whether TypeScript source holds types only: transpiled, nothing but an empty export is left */
export function isTypeOnly(source) {
  const ts = require('typescript');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, removeComments: true },
  });
  return outputText.replace(/export\s*\{\s*\};?/g, '').trim() === '';
}

let typeOnly;
/** The .ts files under src/ that hold types only, found once per process */
export function typeOnlyFiles() {
  if (typeOnly) return typeOnly;
  typeOnly = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const file = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else if (!/\.tsx?$/.test(entry.name) || entry.name.endsWith('.d.ts')) continue;
      else if (isTypeOnly(fs.readFileSync(path.join(ROOT, file), 'utf8'))) typeOnly.push(file);
    }
  };
  walk('src');
  return typeOnly;
}

/**
 * Whether a file (a path from the checkout's root) is one the report counts, by its path alone: the review
 * asks in a checkout with no src/ and no node_modules. A type-only file under src/ passes it, but .c8rc.json
 * excludes it, so no report lists it; countedFiles leaves it out
 */
export function isCounted(file) {
  if (file.includes('node_modules/') || file.endsWith('.d.ts')) return false;
  return file.startsWith('src/') || INSTALL_SCRIPTS.includes(file) || (file.startsWith(`${VENDORED}/`) && !isTest(file));
}

/** Every counted source file in this checkout, the type-only ones left out */
export function countedFiles() {
  const files = [...INSTALL_SCRIPTS];
  const source = (name) => SOURCE.test(name) && !name.endsWith('.d.ts');
  const counts = (file, name) => source(name) && isCounted(file) && !typeOnlyFiles().includes(file);
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const file = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else if (counts(file, entry.name)) files.push(file);
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
  // .c8rc.json's exclude names each type-only file under src/, and no other
  const excluded = JSON.parse(fs.readFileSync(path.join(ROOT, '.c8rc.json'), 'utf8')).exclude
    .filter((pattern) => pattern.startsWith('src/') && !pattern.includes('*'));
  const unexcluded = typeOnlyFiles().filter((file) => !excluded.includes(file));
  const withCode = excluded.filter((file) => !typeOnlyFiles().includes(file));

  if (unexcluded.length > 0) console.error(`✗ Types only, but not in .c8rc.json's exclude: ${unexcluded.join(', ')}`);
  if (withCode.length > 0) console.error(`✗ .c8rc.json excludes them, but they have code: ${withCode.join(', ')}`);
  if (outside.length > 0) {
    console.error(`✗ ${outside.length} file(s) in the coverage report aren't counted product code (src/, the install scripts, ${VENDORED}/), e.g.:`);
    for (const key of outside.slice(0, 10)) console.error(`  ${key}`);
  }
  if (missing.length > 0) {
    console.error(`✗ ${missing.length} of ${sources.length} counted source file(s) aren't in the coverage report, e.g.:`);
    for (const file of missing.slice(0, 10)) console.error(`  ${file}`);
  }
  if (outside.length > 0 || missing.length > 0 || unexcluded.length > 0 || withCode.length > 0) process.exit(1);
  console.log(`✓ Coverage report: all ${sources.length} counted product files (src/, the install scripts, ${VENDORED}/), nothing else`);
}
