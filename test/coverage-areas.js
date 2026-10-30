/**
 * Coverage per area, from c8's coverage-summary.json: each folder under src/
 * (src/tools, src/utils, src/remote-device, src/ui, …), src/'s own files, the
 * install scripts at the root, and vendor/telemetry-contract. A single total hides
 * where the gaps are.
 *
 *   node test/coverage-areas.js [coverage-summary.json]   # prints the table
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTALL_SCRIPTS } from './check-coverage-report.js';
import { ROOT } from './helpers/node-test-runner.js';

const METRICS = ['lines', 'branches', 'functions'];

/**
 * A report key (an absolute path on the machine that ran it) as a path in this
 * checkout: the longest tail of it that exists here.
 */
export function inCheckout(key) {
  const parts = key.split('\\').join('/').split('/');
  for (let i = 1; i < parts.length; i++) {
    const file = parts.slice(i).join('/');
    if (fs.existsSync(path.join(ROOT, file))) return file;
  }
  return key;
}

/** The area of a file: the install scripts, vendor/<package>, or its folder under src/ */
export function areaOf(file) {
  if (INSTALL_SCRIPTS.includes(file)) return 'install scripts';
  const parts = file.split('/');
  if (parts[0] === 'vendor') return parts.slice(0, 2).join('/');
  return parts.length > 2 ? parts.slice(0, 2).join('/') : `${parts[0]}/*`;
}

/** [{ area, files, lines: { total, covered, pct }, branches, functions }], the areas sorted by name */
export function coverageByArea(summary) {
  const areas = new Map();
  for (const [key, data] of Object.entries(summary)) {
    if (key === 'total') continue;
    const area = areaOf(inCheckout(key));
    const sum = areas.get(area) ?? { area, files: 0, ...Object.fromEntries(METRICS.map((m) => [m, { total: 0, covered: 0 }])) };
    sum.files++;
    for (const metric of METRICS) {
      sum[metric].total += data[metric].total;
      sum[metric].covered += data[metric].covered;
    }
    areas.set(area, sum);
  }
  return [...areas.values()].sort((a, b) => a.area.localeCompare(b.area)).map((sum) => {
    for (const metric of METRICS) {
      sum[metric].pct = sum[metric].total === 0 ? 100 : Math.round((1000 * sum[metric].covered) / sum[metric].total) / 10;
    }
    return sum;
  });
}

/** The table as text lines, the total last */
export function areaLines(summary) {
  const cell = ({ pct, covered, total }) => `${pct.toFixed(1).padStart(5)} % (${covered}/${total})`.padEnd(24);
  const row = (name, files, sum) => `  ${name.padEnd(22)} ${String(files).padStart(4)}  ${METRICS.map((m) => cell(sum[m])).join('')}`;
  const areas = coverageByArea(summary);
  return [
    `  ${'area'.padEnd(22)} ${'files'.padStart(4)}  ${METRICS.map((m) => m.padEnd(24)).join('')}`,
    ...areas.map((sum) => row(sum.area, sum.files, sum)),
    row('total', areas.reduce((n, sum) => n + sum.files, 0), summary.total),
  ];
}

// Real paths on both sides: started through a symlink or junction, it still prints
if (process.argv[1] && fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url))) {
  const summaryFile = path.resolve(process.argv[2] ?? path.join(ROOT, 'coverage', 'coverage-summary.json'));
  console.log('Coverage by area:');
  for (const line of areaLines(JSON.parse(fs.readFileSync(summaryFile, 'utf8')))) console.log(line);
}
