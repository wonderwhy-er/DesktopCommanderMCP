import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import { ProcessInfo, ServerResult } from '../types.js';
import { KillProcessArgsSchema } from './schemas.js';
import { resolveProgramPath } from '../utils/shell.js';
import { terminatePid } from '../utils/process-tree.js';

const execFileAsync = promisify(execFile);

/**
 * Parse `tasklist /FO CSV /NH` output (#662). Fields per row, all quoted:
 * [Image Name, PID, Session Name, Session#, Mem Usage]. CSV instead of the
 * default table: image names can contain spaces and Mem Usage contains
 * thousands separators, so positional whitespace splitting can't work.
 * tasklist has no live per-process CPU%, so cpu is reported as n/a.
 */
export function parseWindowsTasklistCsv(stdout: string): ProcessInfo[] {
  return stdout.split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      const fields = (line.match(/"([^"]*)"/g) || []).map(f => f.slice(1, -1));
      return {
        pid: parseInt(fields[1], 10),
        command: fields[0] ?? '',
        cpu: 'n/a',
        memory: fields[4] ?? '',
      } as ProcessInfo;
    })
    .filter(p => !Number.isNaN(p.pid));
}

/**
 * Parse `ps aux` output: 11 whitespace-separated columns, COMMAND from
 * column 10 onward (it can contain spaces, so it must be rejoined, not
 * taken as the last token).
 */
export function parsePsAux(stdout: string): ProcessInfo[] {
  return stdout.split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
    .map(line => {
      const parts = line.trim().split(/\s+/);
      return {
        pid: parseInt(parts[1], 10),
        command: parts.slice(10).join(' ') || parts[parts.length - 1],
        cpu: parts[2],
        memory: parts[3],
      } as ProcessInfo;
    })
    .filter(p => !Number.isNaN(p.pid));
}

/**
 * The leading numeric value of a cpu/memory field, for sorting -- '21,436 K'
 * (Windows tasklist) and '0.5' (ps aux %MEM) both need their thousands
 * separators/units stripped before parseFloat, and 'n/a' (tasklist has no
 * live per-process CPU%) must sort last, not first as NaN would via a plain
 * numeric comparator.
 */
export function numericField(value: string): number {
  const cleaned = value.replace(/,/g, '');
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? -Infinity : n;
}

export async function listProcesses(args: { sortBy?: 'cpu' | 'memory'; limit?: number } = {}): Promise<ServerResult> {
  const isWindows = os.platform() === 'win32';
  const [program, progArgs]: [string, string[]] = isWindows ? ['tasklist', ['/FO', 'CSV', '/NH']] : ['ps', ['aux']];
  try {
    const { stdout } = await execFileAsync(resolveProgramPath(program), progArgs);
    const processes = isWindows ? parseWindowsTasklistCsv(stdout) : parsePsAux(stdout);

    const sortBy = args.sortBy ?? 'memory';
    const sorted = [...processes].sort((a, b) => numericField(b[sortBy]) - numericField(a[sortBy]));
    const limit = args.limit ?? 50;
    const shown = sorted.slice(0, limit);

    const lines = shown.map(p =>
      `PID: ${p.pid}, Command: ${p.command}, CPU: ${p.cpu}, Memory: ${p.memory}`
    );
    // Same visible-truncation pattern list_directory already uses for an oversized
    // nested directory, rather than silently dropping rows or blowing the caller's
    // output limit the way an unfiltered dump did (#the exact bug this fixes).
    if (sorted.length > shown.length) {
      lines.push(`[TRUNCATED] showing top ${shown.length} of ${sorted.length} processes by ${sortBy} (pass limit/sortBy to see more or sort differently)`);
    }

    return {
      content: [{ type: "text", text: lines.join('\n') }],
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: Failed to list processes: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

export async function killProcess(args: unknown): Promise<ServerResult> {
  const parsed = KillProcessArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      content: [{ type: "text", text: `Error: Invalid arguments for kill_process: ${parsed.error}` }],
      isError: true,
    };
  }

  try {
    // Returns once the process is gone, so a success means it no longer runs
    await terminatePid(parsed.data.pid);
    return {
      content: [{ type: "text", text: `Successfully terminated process ${parsed.data.pid}` }],
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: Failed to kill process: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}
