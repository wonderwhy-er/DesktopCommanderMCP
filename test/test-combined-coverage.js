/**
 * The platforms' coverage combined (combined-coverage.js; D4, 100 % on Linux,
 * macOS and Windows together): a line, branch or function counts as covered when
 * any platform ran it. Lines match by number. Branches and functions match by
 * their line and end, since Windows reports start columns one off (its checkout's
 * CRLF). A branch a platform doesn't report, on a line it ran, ran there: V8 drops
 * a block that ran as often as its parent. The result has coverage-summary.json's
 * shape, which coverage-areas.js reads. Made-up reports; starts nothing.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { combineCoverage, readFinals } from './combined-coverage.js';
import { coverageByArea } from './coverage-areas.js';
import { ROOT } from './helpers/node-test-runner.js';
import { runIfMain } from './helpers/run-if-main.js';
import { createTempDir } from './helpers/test-env.js';

const loc = (line, startColumn, endLine, endColumn) => ({ start: { line, column: startColumn }, end: { line: endLine, column: endColumn } });

/**
 * One platform's coverage-final.json entry for a file: lines (statements) by number
 * with their hits, branches [line, start column, end line, end column, hits], and
 * functions [line, hits]
 */
function final(file, { lines, branches = [], functions = [] }) {
  const statements = Object.entries(lines);
  return {
    path: file,
    statementMap: Object.fromEntries(statements.map(([line], i) => [i, loc(Number(line), 0, Number(line), 10)])),
    s: Object.fromEntries(statements.map(([, hits], i) => [i, hits])),
    branchMap: Object.fromEntries(branches.map(([line, from, endLine, to], i) => [i, { type: 'branch', line, loc: loc(line, from, endLine, to), locations: [loc(line, from, endLine, to)] }])),
    b: Object.fromEntries(branches.map(([, , , , hits], i) => [i, [hits]])),
    fnMap: Object.fromEntries(functions.map(([line], i) => [i, { name: `f${i}`, line, decl: loc(line, 9, line, 12), loc: loc(line, 0, line + 1, 1) }])),
    f: Object.fromEntries(functions.map(([, hits], i) => [i, hits])),
  };
}

export default async function run() {
  const edit = path.join(ROOT, 'src', 'tools', 'edit.ts');
  const index = path.join(ROOT, 'src', 'index.ts');
  // The same file as each runner names it: a Linux, a macOS and a Windows path
  const linux = { [edit]: final(`/home/runner/work/DesktopCommanderMCP/DesktopCommanderMCP/src/tools/edit.ts`, {
    lines: { 1: 1, 2: 0, 3: 0, 4: 1 },
    branches: [[2, 4, 2, 9, 0], [3, 4, 3, 9, 0], [4, 4, 4, 9, 0]],
    functions: [[1, 1], [3, 0]],
  }) };
  const macos = { [edit]: final(`/Users/runner/work/DesktopCommanderMCP/DesktopCommanderMCP/src/tools/edit.ts`, {
    lines: { 1: 1, 2: 1, 3: 0, 4: 1 },
    branches: [[2, 4, 2, 9, 1], [3, 4, 3, 9, 0], [4, 4, 4, 9, 0]],
    functions: [[1, 1], [3, 0]],
  }) };
  // Windows: start columns one off; line 4's branch not reported (it ran as often as its parent); one branch of its own
  const windows = {
    [edit]: final(`D:\\a\\DesktopCommanderMCP\\DesktopCommanderMCP\\src\\tools\\edit.ts`, {
      lines: { 1: 1, 2: 0, 3: 1, 4: 1, 5: 0 },
      branches: [[2, 3, 2, 9, 0], [3, 3, 3, 9, 1], [5, 3, 5, 9, 0]],
      functions: [[1, 1], [3, 1]],
    }),
    [index]: final(`D:\\a\\DesktopCommanderMCP\\DesktopCommanderMCP\\src\\index.ts`, { lines: { 1: 0, 2: 0 } }),
  };

  const combined = combineCoverage([linux, macos, windows]);
  const file = Object.keys(combined).find((key) => key.endsWith('edit.ts'));
  assert.ok(file && path.isAbsolute(file), `a file is its path in this checkout: ${Object.keys(combined).join(', ')}`);
  const entry = combined[file];
  assert.deepStrictEqual([entry.lines.covered, entry.lines.total], [4, 5], 'lines 1-4 ran on some platform; line 5 on none');
  assert.deepStrictEqual(entry.statements, entry.lines, 'statements are the lines, as in c8\'s report');
  assert.deepStrictEqual([entry.functions.covered, entry.functions.total], [2, 2], 'each function ran on some platform');
  // Branches: line 2 ran on macOS, line 3 on Windows, line 4's ran on Windows (unreported on a line it ran), line 5's on none
  assert.deepStrictEqual([entry.branches.covered, entry.branches.total], [3, 4], 'the same branch with Windows\' columns is one branch');
  assert.strictEqual(entry.lines.pct, 80);
  console.log('✓ a line, branch or function counts when any platform ran it; Windows\' columns match');

  const other = Object.keys(combined).find((key) => key.endsWith('index.ts'));
  assert.deepStrictEqual([combined[other].lines.covered, combined[other].lines.total], [0, 2], 'a file one platform alone reports is still counted');
  assert.deepStrictEqual(combined.total.lines, { total: 7, covered: 4, skipped: 0, pct: 57.14 }, 'the total sums the files, its pct cut to two decimals as c8 does');
  const areas = coverageByArea(combined);
  assert.deepStrictEqual(areas.map(({ area, files }) => [area, files]), [['src/*', 1], ['src/tools', 1]], 'coverage-areas.js reads the result');
  console.log('✓ coverage-summary.json\'s shape, which coverage-areas.js reads');

  // Fail closed: a report that's missing or can't be read stops it, naming the file
  const dir = createTempDir('dc-combined-coverage-');
  try {
    const good = path.join(dir, 'linux.json');
    fs.writeFileSync(good, JSON.stringify(linux));
    const bad = path.join(dir, 'windows.json');
    fs.writeFileSync(bad, '{"cut off');
    assert.strictEqual(readFinals([good]).length, 1);
    assert.throws(() => readFinals([good, bad]), (error) => error.message.includes('windows.json'), 'an unreadable report');
    assert.throws(() => readFinals([good, path.join(dir, 'macos.json')]), (error) => error.message.includes('macos.json'), 'a missing report');
    console.log('✓ a missing or unreadable report stops it, naming the file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

runIfMain(import.meta.url, run);
