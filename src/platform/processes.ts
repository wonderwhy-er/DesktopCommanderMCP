import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ProcessInfo } from '../types.js';

const execFileAsync = promisify(execFile);
const PROCESS_OUTPUT_LIMIT = 10 * 1024 * 1024;

export interface DetailedProcessInfo extends ProcessInfo {
  ppid?: number;
  user?: string;
  runtime?: string;
  args?: string;
}

function parsePosixArgsOutput(output: string): Map<number, string> {
  const argsByPid = new Map<number, string>();

  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)(?:\s+(.*))?$/);
    if (!match) continue;
    argsByPid.set(Number(match[1]), match[2]?.trim() || '');
  }

  return argsByPid;
}

export function parsePosixProcessOutput(
  summaryOutput: string,
  argsOutput = '',
): DetailedProcessInfo[] {
  const processes: DetailedProcessInfo[] = [];
  const argsByPid = parsePosixArgsOutput(argsOutput);
  const pattern = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(.+?)\s*$/;

  for (const line of summaryOutput.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(pattern);
    if (!match) continue;

    const pid = Number(match[1]);
    processes.push({
      pid,
      ppid: Number(match[2]),
      user: match[3],
      cpu: match[4],
      memory: match[5],
      runtime: match[6],
      command: match[7],
      args: argsByPid.get(pid),
    });
  }

  return processes;
}

interface WindowsProcessRecord {
  pid: number;
  ppid?: number;
  command?: string;
  args?: string | null;
  memoryMb?: number;
}

export function parseWindowsProcessOutput(output: string): DetailedProcessInfo[] {
  if (!output.trim()) return [];
  const parsed = JSON.parse(output) as WindowsProcessRecord | WindowsProcessRecord[];
  const records = Array.isArray(parsed) ? parsed : [parsed];

  return records.map((record) => ({
    pid: Number(record.pid),
    ppid: record.ppid === undefined ? undefined : Number(record.ppid),
    command: record.command || 'unknown',
    args: record.args || undefined,
    cpu: 'n/a',
    memory: record.memoryMb === undefined ? 'n/a' : `${record.memoryMb} MB`,
  }));
}

function getWindowsProcessScript(includeArgs: boolean): string {
  const argsProperty = includeArgs ? 'args = $_.CommandLine;' : '';

  return [
    '$items = Get-CimInstance Win32_Process | ForEach-Object {',
    '  [pscustomobject]@{',
    '    pid = $_.ProcessId; ppid = $_.ParentProcessId; command = $_.Name;',
    `    ${argsProperty} memoryMb = [math]::Round($_.WorkingSetSize / 1MB, 1)`,
    '  }',
    '};',
    '$items | ConvertTo-Json -Compress',
  ].join(' ');
}

async function runPs(
  platform: NodeJS.Platform,
  format: string,
): Promise<string> {
  const mode = platform === 'darwin' ? '-axo' : '-eo';
  const { stdout } = await execFileAsync('ps', [mode, format], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: PROCESS_OUTPUT_LIMIT,
    env: { ...process.env, LC_ALL: 'C' },
  });
  return String(stdout);
}

export async function listPlatformProcesses(
  platform: NodeJS.Platform = process.platform,
  includeArgs = false,
): Promise<DetailedProcessInfo[]> {
  if (platform === 'win32') {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', getWindowsProcessScript(includeArgs)],
      { encoding: 'utf8', windowsHide: true, maxBuffer: PROCESS_OUTPUT_LIMIT },
    );
    return parseWindowsProcessOutput(String(stdout));
  }

  const runtimeField = platform === 'darwin' ? 'etime=' : 'etimes=';
  const summaryFormat = `pid=,ppid=,user=,%cpu=,%mem=,${runtimeField},comm=`;
  const summaryOutput = await runPs(platform, summaryFormat);

  if (!includeArgs) {
    return parsePosixProcessOutput(summaryOutput);
  }

  const argsOutput = await runPs(platform, 'pid=,args=');
  return parsePosixProcessOutput(summaryOutput, argsOutput);
}
