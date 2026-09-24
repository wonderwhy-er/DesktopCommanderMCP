// Repro: a Desktop Commander process frozen for over 30 s while it holds the
// config lock dies once it runs again, if another Desktop Commander process
// wrote config.json meanwhile (seen as a failed test-search-without-ripgrep.js
// in a full Windows run: "Error: Unable to update lock within the stale
// threshold { code: 'ECOMPROMISED' }").
//
// Mechanism: proper-lockfile refreshes a held lock every 10 s; one not
// refreshed for 30 s is stale, and the next process that wants it removes it
// and takes it. When the frozen holder runs again, its refresh finds the lock
// gone or no longer its own, and proper-lockfile's default reaction throws
// from a timer: an uncaught exception, which exits the process (the server's
// handler in index.ts exits too). Frozen alone, with nobody else writing, the
// holder survives. Freezes in real life: machine sleep, a suspended process
// (debugger, paused VM, Ctrl+Z), a test blocking its event loop in spawnSync.
//
// Measured on cbccab9 (holder frozen by spawnSync as soon as it holds the lock,
// the other process's writes waiting for it): the other process took the lock
// over after ~30 s and the holder died of ECOMPROMISED in 3 of 3 runs on
// Windows 11 and 3 of 3 on macOS 26. With two real servers frozen by
// SIGSTOP / NtSuspendProcess for 36 s the frozen one exited the same way on
// both; frozen alone it survived.
//
// Here the holder (its own config manager) starts a config write and, the
// moment it holds the lock, freezes itself in spawnSync, running a second
// process that keeps trying to write config.json (as a server's saves do)
// until it can. Then the holder runs again for 3 s.
//
// Run: node test/repro/run-repro.js test-config-lock-frozen-holder.js
//      (about 35 s per run; REPRO_RUNS=1 by default)
// Exit code: 1 if the holder died.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { isTestHome } from '../helpers/test-env.js';
import { exitProcess } from '../../dist/utils/exit-process.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG_MANAGER = pathToFileURL(path.join(PROJECT_ROOT, 'dist', 'config-manager.js')).href;
const RUNS = Number(process.env.REPRO_RUNS || 1);

// This writes config.json, so never in a real home
if (!isTestHome()) {
  console.error('Run it through the repro runner: node test/repro/run-repro.js test-config-lock-frozen-holder.js');
  exitProcess(2);
}

// The other process: writes config.json, trying again while the lock is held
const WRITER = `
  const { configManager } = await import(${JSON.stringify(CONFIG_MANAGER)});
  for (;;) {
    try { await configManager.setValue('writtenByOther', true); break; }
    catch (error) { if (error.code !== 'ELOCKED') throw error; }
  }`;

// The holder: frozen in spawnSync from the moment it holds the lock
const holder = (out) => `
  import fs from 'fs';
  import { spawnSync } from 'child_process';
  const { configManager } = await import(${JSON.stringify(CONFIG_MANAGER)});
  await configManager.getConfig();
  const acquire = configManager.acquireConfigLock.bind(configManager);
  let held;
  const holding = new Promise((resolve) => { held = resolve; });
  configManager.acquireConfigLock = async () => { const release = await acquire(); held(); return release; };
  void configManager.setValue('writtenByHolder', true);
  await holding;
  const started = Date.now();
  const writer = spawnSync(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(WRITER)}], { encoding: 'utf8', timeout: 90000 });
  fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ frozenMs: Date.now() - started, writerStatus: writer.status, writerError: writer.stderr.slice(0, 300) }));
  setTimeout(() => { fs.appendFileSync(${JSON.stringify(out)} + '.survived', 'yes'); process.exit(0); }, 3000);`;

async function runRepro() {
  const configDir = path.join(os.homedir(), '.claude-server-commander');
  let died = 0;
  for (let run = 1; run <= RUNS; run++) {
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ telemetryEnabled: false, pendingWelcomeOnboarding: false, welcomeOnboardingEligible: false }, null, 2));
    const out = path.join(os.homedir(), `holder-${run}.json`);
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', holder(out)], { encoding: 'utf8', timeout: 150000 });
    let frozen = {};
    try { frozen = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* the holder died before writing it */ }
    const survived = fs.existsSync(`${out}.survived`);
    if (!survived) died++;
    const crash = (result.stderr.match(/Error[^\n]*|code: '[A-Z]+'/g) ?? []).slice(0, 2).join(' ');
    console.log(`run ${run}: holder frozen ${frozen.frozenMs} ms (the other process ${frozen.writerStatus === 0 ? 'wrote config.json' : `failed: ${frozen.writerError}`}); holder ${survived ? 'survived' : `DIED (exit ${result.status}): ${crash}`}`);
  }

  console.log(died > 0
    ? `REPRODUCED: the holder died in ${died} of ${RUNS} runs after being frozen inside the config lock while another process wrote config.json`
    : `NOT REPRODUCED: the holder survived ${RUNS} of ${RUNS} runs after being frozen inside the config lock while another process wrote config.json`);
  exitProcess(died > 0 ? 1 : 0);
}

// Only in a test home: outside one, the check above refused to run
if (isTestHome()) await runRepro();
