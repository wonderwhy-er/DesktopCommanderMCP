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
  const byPlace = ([, a], [, b]) => {
    const [from, to] = [locOf(a).start, locOf(b).start];
    return from.line - to.line || from.column - to.column;
  };
  return Object.entries(map).sort(byPlace).map(([id, item]) => {
    const { start, end } = locOf(item);
    const base = `${start.line}-${end.line}:${end.column}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { key: `${base}#${n}`, id, item };
  });
}

/** A metric as c8's json-summary writes it, its percentage cut to two decimals */
function metric(covered, total) {
  return { total, covered, skipped: 0, pct: total === 0 ? 100 : Math.floor((10000 * covered) / total) / 100 };
}

const ran = (hits) => (hits ?? 0) > 0;

/** Lines: each line any platform has, covered when one ran it */
function combineLines(lines) {
  const all = new Set(lines.flatMap((each) => [...each.keys()]));
  return metric([...all].filter((line) => lines.some((each) => ran(each.get(line)))).length, all.size);
}

/** Branch paths: covered when a platform ran one, or doesn't report it on a line it ran */
function combineBranches(reports, lines) {
  const branches = reports.map((data) => new Map(keyed(data.branchMap, (branch) => branch.loc)
    .map(({ key, id, item }) => [key, { item, hits: data.b[id] ?? [] }])));
  const all = new Map();
  for (const each of branches) for (const [key, { item }] of each) if (!all.has(key)) all.set(key, item);
  let total = 0;
  let covered = 0;
  for (const [key, item] of all) {
    for (let i = 0; i < item.locations.length; i++) {
      total++;
      const onLine = (p) => ran(lines[p].get(item.loc.start.line));
      if (branches.some((each, p) => (each.has(key) ? ran(each.get(key).hits[i]) : onLine(p)))) covered++;
    }
  }
  return metric(covered, total);
}

/** Functions: covered when any platform ran one */
function combineFunctions(reports) {
  const functions = reports.map((data) => new Map(keyed(data.fnMap, (fn) => fn.decl)
    .map(({ key, id }) => [key, data.f[id]])));
  const all = new Set(functions.flatMap((each) => [...each.keys()]));
  return metric([...all].filter((key) => functions.some((each) => ran(each.get(key)))).length, all.size);
}

/** One file's reports, one per platform that has it, combined: { lines, statements, branches, functions } */
function combineFile(reports) {
  const lines = reports.map(linesOf);
  const lineMetric = combineLines(lines);
  return {
    lines: lineMetric,
    statements: { ...lineMetric },
    branches: combineBranches(reports, lines),
    functions: combineFunctions(reports),
  };
}

/** Each file's reports from the platforms that have it, by its path in this checkout */
function reportsByFile(finals) {
  const byFile = new Map();
  for (const final of finals) {
    for (const data of Object.values(final)) {
      const file = path.join(ROOT, inCheckout(data.path)).split('\\').join('/');
      byFile.set(file, [...(byFile.get(file) ?? []), data]);
    }
  }
  return [...byFile].sort(([a], [b]) => a.localeCompare(b));
}

/** Several platforms' coverage-final.json contents combined, in coverage-summary.json's shape */
export function combineCoverage(finals) {
  const summary = {};
  const totals = { lines: [0, 0], statements: [0, 0], branches: [0, 0], functions: [0, 0] };
  for (const [file, reports] of reportsByFile(finals)) {
    summary[file] = combineFile(reports);
    for (const [name, sum] of Object.entries(totals)) {
      sum[0] += summary[file][name].covered;
      sum[1] += summary[file][name].total;
    }
  }
  const total = {};
  for (const [name, [covered, sum]] of Object.entries(totals)) total[name] = metric(covered, sum);
  return { total, ...summary };
}

// Real paths on both sides: started through a symlink or junction, it still prints
const real = (file) => fs.realpathSync.native(file);
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('Usage: node test/combined-coverage.js <coverage-final.json>...');
    process.exit(1);
  }
  console.log(`Coverage by area, ${files.length} reports combined:`);
  for (const line of areaLines(combineCoverage(readFinals(files)))) console.log(line);
}
