/**
 * The platforms' coverage combined, for the target of 100 % on Linux, macOS and
 * Windows together: each platform's coverage-final.json merged, a line, branch or
 * function covered when any platform ran it.
 * - Lines match by number.
 * - Branches match by their line and end, functions by their declaration's: Windows
 *   reports start columns one off (its checkout's CRLF). Two on one line with the
 *   same end are told apart by their order.
 * - A branch a platform doesn't report, on a line that platform ran, ran there: V8
 *   drops a block that ran as often as its parent.
 * The result has coverage-summary.json's shape, keyed by each file's path in this
 * checkout, so coverage-areas.js reads it.
 *
 *   node test/combined-coverage.js <coverage-final.json>...   # prints the table by area
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { areaLines, inCheckout } from './coverage-areas.js';
import { ROOT } from './helpers/node-test-runner.js';

/** The coverage-final.json files, read; one missing or unreadable stops it, naming the file */
export function readFinals(files) {
  return files.map((file) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`The coverage report ${file} can't be read: ${error.message}`);
    }
  });
}

/** A file's lines and their hits, as c8 counts them: a statement's first line, its highest count */
function linesOf(data) {
  const lines = new Map();
  for (const [id, { start }] of Object.entries(data.statementMap)) {
    const hits = data.s[id] ?? 0;
    if (!lines.has(start.line) || lines.get(start.line) < hits) lines.set(start.line, hits);
  }
  return lines;
}

/** Entries keyed by their line and end, the start column left out; equal keys numbered in order */
function keyed(map, locOf) {
  const seen = new Map();
  return Object.entries(map)
    .sort(([, a], [, b]) => locOf(a).start.line - locOf(b).start.line || locOf(a).start.column - locOf(b).start.column)
    .map(([id, item]) => {
      const { start, end } = locOf(item);
      const base = `${start.line}-${end.line}:${end.column}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return { key: `${base}#${n}`, id, item };
    });
}

const metric = (covered, total) => ({ total, covered, skipped: 0, pct: total === 0 ? 100 : Math.floor((10000 * covered) / total) / 100 });

/** One file's reports, one per platform that has it, combined: { lines, statements, branches, functions } */
function combineFile(reports) {
  const lines = reports.map(linesOf);
  const allLines = new Set(lines.flatMap((each) => [...each.keys()]));
  const coveredLines = [...allLines].filter((line) => lines.some((each) => (each.get(line) ?? 0) > 0)).length;

  // Each branch path: covered when a platform ran it, or doesn't report it on a line it ran
  const branches = reports.map((data) => new Map(keyed(data.branchMap, (branch) => branch.loc).map(({ key, id, item }) => [key, { item, hits: data.b[id] ?? [] }])));
  const branchKeys = new Map();
  for (const each of branches) for (const [key, { item }] of each) if (!branchKeys.has(key)) branchKeys.set(key, item);
  let branchTotal = 0;
  let branchCovered = 0;
  for (const [key, item] of branchKeys) {
    for (let i = 0; i < item.locations.length; i++) {
      branchTotal++;
      const ran = branches.some((each, p) => (each.has(key) ? (each.get(key).hits[i] ?? 0) > 0 : (lines[p].get(item.loc.start.line) ?? 0) > 0));
      if (ran) branchCovered++;
    }
  }

  const functions = reports.map((data) => new Map(keyed(data.fnMap, (fn) => fn.decl).map(({ key, id }) => [key, data.f[id] ?? 0])));
  const fnKeys = new Set(functions.flatMap((each) => [...each.keys()]));
  const fnCovered = [...fnKeys].filter((key) => functions.some((each) => (each.get(key) ?? 0) > 0)).length;

  const lineMetric = metric(coveredLines, allLines.size);
  return { lines: lineMetric, statements: { ...lineMetric }, branches: metric(branchCovered, branchTotal), functions: metric(fnCovered, fnKeys.size) };
}

/** Several platforms' coverage-final.json contents combined, in coverage-summary.json's shape */
export function combineCoverage(finals) {
  const byFile = new Map();
  for (const final of finals) {
    for (const data of Object.values(final)) {
      const file = path.join(ROOT, inCheckout(data.path)).split('\\').join('/');
      byFile.set(file, [...(byFile.get(file) ?? []), data]);
    }
  }
  const summary = {};
  const totals = { lines: [0, 0], statements: [0, 0], branches: [0, 0], functions: [0, 0] };
  for (const [file, reports] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) {
    summary[file] = combineFile(reports);
    for (const [name, sum] of Object.entries(totals)) {
      sum[0] += summary[file][name].covered;
      sum[1] += summary[file][name].total;
    }
  }
  return { total: Object.fromEntries(Object.entries(totals).map(([name, [covered, total]]) => [name, metric(covered, total)])), ...summary };
}

// Real paths on both sides: started through a symlink or junction, it still prints
if (process.argv[1] && fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url))) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('Usage: node test/combined-coverage.js <coverage-final.json>...');
    process.exit(1);
  }
  console.log(`Coverage by area, ${files.length} reports combined:`);
  for (const line of areaLines(combineCoverage(readFinals(files)))) console.log(line);
}
