/**
 * Peak memory of a process and its direct children (a server and the
 * ripgrep it starts), as the OS sees them. Neither platform reports another
 * process's peak after it exits, so the processes are sampled while they run:
 * - Windows: PeakWorkingSetSize, a true peak the OS keeps per process, read
 *   every `intervalMs` by one long-lived PowerShell. A child that lives
 *   shorter than one interval may not be seen at all.
 * - macOS/Linux: the largest RSS `ps` reports over the samples.
 */
import { execFile, spawn } from 'child_process';
import os from 'os';
import path from 'path';

// A live child can be stuck in startup or CIM; report progress separately from measured peaks.
function observeWindowsSampler(sampler, record, fail) {
  const observed = {
    spawned: false, scriptStarted: false, queriesStarted: 0, queriesCompleted: 0,
    queriesFailed: 0, lastQueryRows: 0, samples: 0, unparsedLines: 0, stderrBytes: 0,
    exited: false, exitCode: null,
  };
  let stopped = false;
  sampler.on('spawn', () => { observed.spawned = true; });
  // Count bytes only: PowerShell errors may contain paths or other private context.
  sampler.stderr.on('data', (chunk) => { observed.stderrBytes += Buffer.byteLength(chunk); });
  sampler.on('error', (error) => fail(`the PowerShell sampler could not run: ${error.message}`));
  sampler.on('exit', (code, signal) => {
    observed.exited = true;
    observed.exitCode = code;
    if (!stopped) fail(`the PowerShell sampler exited (${signal ?? `exit code ${code}`})`);
  });
  let pending = '';
  sampler.stdout.on('data', (chunk) => {
    const lines = (pending + chunk).split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) {
      if (line === 'DC_MEMORY_READY') { observed.scriptStarted = true; continue; }
      if (line === 'DC_MEMORY_QUERY_STARTED') { observed.queriesStarted++; continue; }
      if (line === 'DC_MEMORY_QUERY_FAILED') {
        observed.queriesFailed++;
        fail('the PowerShell sampler could not query process memory');
        continue;
      }
      const completed = /^DC_MEMORY_QUERY_DONE (\d+)$/.exec(line);
      if (completed) {
        observed.queriesCompleted++;
        observed.lastQueryRows = Number(completed[1]);
        continue;
      }
      const sample = line.trim().match(/^(\d+) (\S+) (\d+)$/);
      if (sample) {
        record(Number(sample[1]), sample[2], Number(sample[3]) * 1024); // KB
        observed.samples++;
      } else if (line.trim()) observed.unparsedLines++;
    }
  });
  const stop = () => {
    stopped = true;
    sampler.kill();
  };
  return { stop, diagnostics: () => ({ ...observed }) };
}

/**
 * Starts sampling. Returns `peakOf(pid)` and `peakOfName(prefix)` (bytes),
 * `failure()` and `stop()`, which the caller must call. `failure()` says why
 * sampling failed (the sampler couldn't run or exited, or a sample failed),
 * else is undefined: peaks read without samples are 0, which measures nothing.
 */
export function watchPeakMemory(rootPid, intervalMs = 100) {
  const peaks = new Map(); // pid -> { name, bytes }
  const record = (pid, name, bytes) => {
    const peak = peaks.get(pid);
    if (!peak) peaks.set(pid, { name, bytes });
    else peak.bytes = Math.max(peak.bytes, bytes);
  };
  let failure;
  const fail = (message) => { failure ??= message; };

  let diagnostics = () => ({ platform: process.platform });
  let stop;
  if (process.platform === 'win32') {
    const script = [
      "'DC_MEMORY_READY'",
      'while ($true) {',
      "  'DC_MEMORY_QUERY_STARTED'",
      '  try {',
      `    $rows = @(Get-CimInstance Win32_Process -Filter "ProcessId=${rootPid} OR ParentProcessId=${rootPid}" ` +
        '-ErrorAction Stop)',
      '    "DC_MEMORY_QUERY_DONE $($rows.Count)"',
      '    $rows | ForEach-Object { "$($_.ProcessId) $($_.Name) $($_.PeakWorkingSetSize)" }',
      "  } catch { 'DC_MEMORY_QUERY_FAILED' }",
      `  Start-Sleep -Milliseconds ${intervalMs}`,
      '}',
    ].join('\n');
    const sampler = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // In a test home PowerShell finds no local app data folder and writes its
      // module cache below the working directory instead
      env: { ...process.env, PSModuleAnalysisCachePath: path.join(os.tmpdir(), 'dc-test-ps-module-analysis-cache') },
    });
    ({ stop, diagnostics } = observeWindowsSampler(sampler, record, fail));
  } else {
    let running = true;
    const sample = () => execFile('ps', ['-A', '-o', 'pid=,ppid=,rss=,comm='], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        fail(`ps failed: ${error.message}`); // maxBuffer too
      } else {
        for (const line of stdout.split('\n')) {
          const row = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
          if (row && (Number(row[1]) === rootPid || Number(row[2]) === rootPid)) {
            record(Number(row[1]), row[4].split('/').pop(), Number(row[3]) * 1024); // KB
          }
        }
      }
      if (running) setTimeout(sample, intervalMs);
    });
    sample();
    stop = () => { running = false; };
  }

  return {
    /** Peak bytes of one process; 0 if it was never seen */
    peakOf: (pid) => peaks.get(pid)?.bytes ?? 0,
    /** Largest peak among the processes whose executable name starts with `prefix` */
    peakOfName: (prefix) => Math.max(0, ...[...peaks.values()].filter((p) => p.name.startsWith(prefix)).map((p) => p.bytes)),
    /** Why sampling failed, or undefined */
    failure: () => failure,
    /** Safe phase/counter snapshot; no process arguments, environment or error text. */
    diagnostics: () => diagnostics(),
    stop: () => stop(),
  };
}

/** Bytes as whole megabytes, for reports */
export const formatMB = (bytes) => `${Math.round(bytes / 1024 / 1024)} MB`;
