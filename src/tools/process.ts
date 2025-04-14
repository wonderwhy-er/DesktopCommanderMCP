import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import { ProcessInfo, ServerResult } from '../types.js';
import { KillProcessArgsSchema } from './schemas.js';

const execAsync = promisify(exec);

export async function listProcesses(): Promise<ServerResult> {
  const command = os.platform() === 'win32' ? 'tasklist' : 'ps aux';
  try {
    const { stdout } = await execAsync(command);
    const processes = stdout.split('\n')
      .slice(1)
      .filter(Boolean)
      .map(line => {
        const parts = line.split(/\s+/);
        return {
          pid: parseInt(parts[1]),
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
