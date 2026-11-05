/**
 * The coverage report's areas (coverage-areas.js): a report key from any machine
 * is its file in this checkout, each file has an area, each area sums its files,
 * and the table ends with one total. Reads this
 * checkout's files; starts nothing.
 */
import assert from 'assert';
import path from 'path';
import { areaLines, areaOf, coverageByArea, inCheckout } from './coverage-areas.js';
import { ROOT } from './helpers/node-test-runner.js';
import { runIfMain } from './helpers/run-if-main.js';

/** A metric as c8's json-summary writes it, its percentage included (100 with nothing to cover) */
const metric = (covered, total) => ({ covered, total, skipped: 0, pct: total === 0 ? 100 : Math.floor((10000 * covered) / total) / 100 });
/** A coverage-summary.json entry: lines covered of total, half the branches, no functions */
const entry = (covered, total) => ({
  lines: metric(covered, total),
  statements: metric(covered, total),
  branches: metric(1, 2),
  functions: metric(0, 0),
});

export default async function run() {
  // A key from another machine, POSIX or Windows, is its longest tail that exists here
  assert.strictEqual(inCheckout('/home/runner/work/DesktopCommanderMCP/DesktopCommanderMCP/src/tools/edit.ts'), 'src/tools/edit.ts');
  assert.strictEqual(inCheckout('D:\\a\\DesktopCommanderMCP\\DesktopCommanderMCP\\src\\index.ts'), 'src/index.ts');
  assert.strictEqual(inCheckout(path.join(ROOT, 'test', 'run-ci.js')), 'test/run-ci.js');
  assert.strictEqual(inCheckout('/nowhere/at/all.ts'), '/nowhere/at/all.ts', 'a key not in this checkout stays as it is');
  console.log('✓ a report key is its file in this checkout');

  assert.strictEqual(areaOf('src/tools/edit.ts'), 'src/tools');
  assert.strictEqual(areaOf('src/index.ts'), 'src/*', 'src/\'s own files');
  assert.strictEqual(areaOf('src/ui/file-preview/src/app.ts'), 'src/ui', 'src/ui is an ordinary area');
  assert.strictEqual(areaOf('setup-claude-server.js'), 'install scripts');
  assert.strictEqual(areaOf('vendor/telemetry-contract/transport.js'), 'vendor/telemetry-contract');
  console.log('✓ each file\'s area');

  const summary = {
    total: entry(15, 40),
    [path.join(ROOT, 'src', 'tools', 'edit.ts')]: entry(5, 10),
    [path.join(ROOT, 'src', 'tools', 'filesystem.ts')]: entry(5, 10),
    [path.join(ROOT, 'src', 'index.ts')]: entry(0, 10),
    [path.join(ROOT, 'vendor', 'telemetry-contract', 'transport.js')]: entry(5, 10),
  };
  const areas = coverageByArea(summary);
  assert.deepStrictEqual(areas.map(({ area, files }) => [area, files]), [['src/*', 1], ['src/tools', 2], ['vendor/telemetry-contract', 1]], 'sorted by name, files counted');
  assert.deepStrictEqual(areas[1].lines, { covered: 10, total: 20, pct: 50 }, 'an area sums its files');
  assert.strictEqual(areas[0].lines.pct, 0);
  assert.strictEqual(areas[0].branches.pct, 50);
  assert.strictEqual(areas[0].functions.pct, 100, 'nothing to cover is 100 %');
  const table = areaLines(summary);
  assert.ok(table[0].includes('area') && table.at(-1).trimStart().startsWith('total'), 'a header, the areas, then the total');
  assert.ok(table.at(-1).includes('37.5 % (15/40)'), 'the total is the report\'s own');
  assert.strictEqual(table.length, 5, 'one line per area and one total, no other total');
  console.log('✓ each area sums its files; the table ends with one total');
}

runIfMain(import.meta.url, run);
