import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import { ProcessInfo, ServerResult } from '../types.js';
import { KillProcessArgsSchema } from './schemas.js';

const execAsync = promisify(exec);

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

export async function listProcesses(): Promise<ServerResult> {
  const isWindows = os.platform() === 'win32';
  const command = isWindows ? 'tasklist /FO CSV /NH' : 'ps aux';
  try {
    const { stdout } = await execAsync(command);
    const processes = isWindows ? parseWindowsTasklistCsv(stdout) : parsePsAux(stdout);

    return {
      content: [{
        type: "text",
        text: processes.map(p =>
          `PID: ${p.pid}, Command: ${p.command}, CPU: ${p.cpu}, Memory: ${p.memory}`
        ).join('\n')
      }],
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
    process.kill(parsed.data.pid);
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
