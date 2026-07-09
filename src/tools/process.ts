import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import { ProcessInfo, ServerResult } from '../types.js';
import { KillProcessArgsSchema } from './schemas.js';

const execAsync = promisify(exec);

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }

  fields.push(field);
  return fields;
}

export async function listProcesses(): Promise<ServerResult> {
  const isWindows = os.platform() === 'win32';
  const command = isWindows ? 'tasklist /FO CSV /NH' : 'ps aux';
  try {
    const { stdout } = await execAsync(command);
    const processes = isWindows
      ? stdout.split(/\r?\n/)
        .filter(Boolean)
        .map(line => parseCsvLine(line))
        .map(parts => {
          const pid = Number.parseInt(parts[1], 10);
          if (!Number.isInteger(pid)) return null;
          return {
            pid,
            command: parts[0],
            cpu: 'N/A',
            memory: parts[4] ?? 'N/A',
          } as ProcessInfo;
        })
        .filter((process): process is ProcessInfo => process !== null)
      : stdout.split('\n')
        .slice(1)
        .filter(Boolean)
        .map(line => {
          const parts = line.split(/\s+/);
          return {
            pid: parseInt(parts[1], 10),
            command: parts[parts.length - 1],
            cpu: parts[2],
            memory: parts[3],
          } as ProcessInfo;
        });

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
