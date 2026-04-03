import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import { ProcessInfo, ServerResult } from '../types.js';
import { KillProcessArgsSchema } from './schemas.js';
import { terminalManager } from '../terminal-manager.js';

const execAsync = promisify(exec);

/**
 * Lists all running system processes with their PID, command, CPU, and memory usage.
 * Uses `ps aux` on Unix and `tasklist` on Windows.
 */
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

/**
 * Terminates a process started via Desktop Commander's start_process tool.
 * Only processes tracked by the internal terminal manager can be killed,
 * preventing the AI agent from terminating arbitrary system processes.
 *
 * @param args Tool arguments containing the target PID. Parsed via KillProcessArgsSchema.
 */
export async function killProcess(args: unknown): Promise<ServerResult> {
  const parsed = KillProcessArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      content: [{ type: "text", text: `Error: Invalid arguments for kill_process: ${parsed.error}` }],
      isError: true,
    };
  }

  // Scope kill_process to sessions managed by Desktop Commander.
  // This prevents the AI agent from terminating arbitrary system processes.
  const session = terminalManager.getSession(parsed.data.pid);
  if (!session) {
    return {
      content: [{ type: "text", text: `Error: PID ${parsed.data.pid} is not a process managed by Desktop Commander. ` +
        `kill_process and force_terminate can only terminate processes started via start_process. ` +
        `For other system processes, use OS-level tools directly.` }],
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
