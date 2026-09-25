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

  let stop;
  if (process.platform === 'win32') {
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      'while ($true) {',
      `  Get-CimInstance Win32_Process -Filter "ProcessId=${rootPid} OR ParentProcessId=${rootPid}" |`,
      '    ForEach-Object { "$($_.ProcessId) $($_.Name) $($_.PeakWorkingSetSize)" }',
      `  Start-Sleep -Milliseconds ${intervalMs}`,
      '}',
    ].join('\n');
    const sampler = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      // In a test home PowerShell finds no local app data folder and writes its
      // module cache below the working directory instead
      env: { ...process.env, PSModuleAnalysisCachePath: path.join(os.tmpdir(), 'dc-test-ps-module-analysis-cache') },
    });
    let stopped = false;
    sampler.on('error', (error) => fail(`the PowerShell sampler could not run: ${error.message}`));
    sampler.on('exit', (code, signal) => {
      if (!stopped) fail(`the PowerShell sampler exited (${signal ?? `exit code ${code}`})`);
    });
    let pending = '';
    sampler.stdout.on('data', (chunk) => {
      const lines = (pending + chunk).split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        const sample = line.trim().match(/^(\d+) (\S+) (\d+)$/);
        if (sample) record(Number(sample[1]), sample[2], Number(sample[3]) * 1024); // KB
      }
    });
    stop = () => {
      stopped = true;
      sampler.kill();
    };
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
    stop: () => stop(),
  };
}

/** Bytes as whole megabytes, for reports */
export const formatMB = (bytes) => `${Math.round(bytes / 1024 / 1024)} MB`;
