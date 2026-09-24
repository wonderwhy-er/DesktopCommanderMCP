// Repro (#715): Desktop Commander takes 25-90 s to answer the MCP `initialize`
// request on the reporter's Windows 11 machine (Node 24.14, 0.2.50 local
// clone), one core busy for ~25 s, and the client gives up; loading the
// Excel, PDF and DOCX packages on first use brought it to 8-10 s there.
//
// Every launch loads the packages that only reading, writing and rendering
// Excel, PDF and DOCX files need (exceljs, pdf-lib, md-to-pdf with puppeteer,
// unpdf, @opendocsg/pdf2md, pizzip), before it answers `initialize`, whether
// or not the session ever opens such a file: the server's startup modules
// import them at the top of the file.
//
// Here the built server is started the way a client starts it (MCP over
// stdio), with a preload that records every module it resolves (import and
// require). Each run reports how long `initialize` took (a measurement, not a
// verdict), how many modules were loaded before the answer and how many of
// them came in through those packages, then lists the ones loaded once
// tools/list has been answered and the Chrome warm-up after the handshake has
// run.
//
// Run: node test/repro/run-repro.js test-startup-heavy-imports.js
//      (REPRO_RUNS=5 starts by default)
// Exit code: 1 if any of those packages is loaded by then.
import { HEAVY_PACKAGES, packageOf, startServerRecordingModules } from '../helpers/server-modules.js';
import { exitProcess } from '../../dist/utils/exit-process.js';

const RUNS = Number(process.env.REPRO_RUNS || 5);
const WARM_UP_TIMEOUT_MS = 60_000;

/** For each module, the heavy package it was first loaded through, if any */
function heavyPackageBehind(modules) {
  const byUrl = new Map(modules.map((module) => [module.url, module]));
  const behind = new Map();
  const find = (module, depth = 0) => {
    if (behind.has(module.url)) return behind.get(module.url);
    const pkg = packageOf(module.url);
    let result;
    if (pkg && HEAVY_PACKAGES.includes(pkg)) result = pkg;
    else if (pkg && module.parent && byUrl.has(module.parent) && depth < 200) result = find(byUrl.get(module.parent), depth + 1);
    behind.set(module.url, result);
    return result;
  };
  for (const module of modules) find(module);
  return behind;
}

function describe(modules) {
  const own = modules.filter((module) => !module.url.startsWith('node:'));
  const behind = heavyPackageBehind(own);
  const counts = {};
  for (const module of own) {
    const pkg = behind.get(module.url);
    if (pkg) counts[pkg] = (counts[pkg] ?? 0) + 1;
  }
  const heavy = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const detail = Object.entries(counts).map(([pkg, count]) => `${pkg} ${count}`).join(', ');
  return `${own.length} modules, ${heavy ? `${heavy} of them through ${detail}` : 'none of them through those packages'}`;
}

const heavyLoaded = (modules) => HEAVY_PACKAGES.filter((pkg) => modules.some((module) => packageOf(module.url) === pkg));

let runsLoadingHeavy = 0;
const startupMs = [];
for (let run = 1; run <= RUNS; run++) {
  const server = await startServerRecordingModules();
  try {
    const beforeAnswer = server.modules().filter((module) => module.at <= server.initializedAt);
    startupMs.push(server.initializedAt - server.startedAt);
    console.log(`start ${run}: initialize answered after ${server.initializedAt - server.startedAt} ms; loaded before it: ${describe(beforeAnswer)}`);

    await server.client.listTools();
    const warmedUp = await server.waitForChromeWarmUp(WARM_UP_TIMEOUT_MS);
    const loaded = heavyLoaded(server.modules());
    if (loaded.length > 0) runsLoadingHeavy++;
    console.log(`  after tools/list and the Chrome warm-up${warmedUp ? '' : ' (still running)'}: ${loaded.length ? `loaded ${loaded.join(', ')}` : 'none of those packages loaded'}`);
  } finally {
    await server.close();
  }
}

startupMs.sort((a, b) => a - b);
const median = startupMs[Math.floor(startupMs.length / 2)];
console.log(runsLoadingHeavy > 0
  ? `REPRODUCED: ${runsLoadingHeavy} of ${RUNS} starts loaded Excel/PDF/DOCX packages without opening any such file (initialize answered after ${median} ms median)`
  : `NOT REPRODUCED: ${RUNS} starts, none loaded Excel/PDF/DOCX packages (initialize answered after ${median} ms median)`);
exitProcess(runsLoadingHeavy > 0 ? 1 : 0);
