import { terminalManager } from '../terminal-manager.js';
import { commandManager } from '../command-manager.js';
import { ExecuteCommandArgsSchema, ReadOutputArgsSchema, ForceTerminateArgsSchema, ListSessionsArgsSchema } from './schemas.js';
import { capture } from "../utils/capture.js";
import { ServerResult } from '../types.js';

export async function executeCommand(args: unknown): Promise<ServerResult> {
  const parsed = ExecuteCommandArgsSchema.safeParse(args);
  if (!parsed.success) {
    capture('server_execute_command_failed');
    return {
      content: [{ type: "text", text: `Error: Invalid arguments for execute_command: ${parsed.error}` }],
      isError: true,
    };
  }

  try {
    // Extract all commands for analytics while ensuring execution continues even if parsing fails
    const commands = commandManager.extractCommands(parsed.data.command).join(', ');
    capture('server_execute_command', {
      command: commandManager.getBaseCommand(parsed.data.command), // Keep original for backward compatibility
      commands: commands // Add the array of all identified commands
    });
  } catch (error) {
    // If anything goes wrong with command extraction, just continue with execution
    capture('server_execute_command', {
      command: commandManager.getBaseCommand(parsed.data.command)
    });
  }

  // Command validation is now async
  const isAllowed = await commandManager.validateCommand(parsed.data.command);
  if (!isAllowed) {
    return {
      content: [{ type: "text", text: `Error: Command not allowed: ${parsed.data.command}` }],
      isError: true,
    };
  }

  const result = await terminalManager.executeCommand(
    parsed.data.command,
    parsed.data.timeout_ms,
    parsed.data.shell
  );

  // Check for error condition (pid = -1)
  if (result.pid === -1) {
    return {
      content: [{ type: "text", text: result.output }],
      isError: true,
    };
  }

  return {
    content: [{
      type: "text",
      text: `Command started with PID ${result.pid}\nInitial output:\n${result.output}${
        result.isBlocked ? '\nCommand is still running. Use read_output to get more output.' : ''
      }`
    }],
  };
}

export async function readOutput(args: unknown): Promise<ServerResult> {
    const parsed = ReadOutputArgsSchema.safeParse(args);
    if (!parsed.success) {
        return {
            content: [{ type: "text", text: `Error: Invalid arguments for read_output: ${parsed.error}` }],
            isError: true,
        };
    }

    const { pid, timeout_ms = 5000 } = parsed.data;

    // Check if the process exists
    const session = terminalManager.getSession(pid);
    if (!session) {
        return {
            content: [{ type: "text", text: `No session found for PID ${pid}` }],
            isError: true,
        };
    }
    // Wait for output with timeout
    let output = "";
    let timeoutReached = false;
    try {
        // Create a promise that resolves when new output is available or when timeout is reached
        const outputPromise: Promise<string> = new Promise<string>((resolve) => {
            // Check for initial output
            const initialOutput = terminalManager.getNewOutput(pid);
            if (initialOutput && initialOutput.length > 0) {
                resolve(initialOutput);
                return;
            }

            let resolved = false;
            let interval: NodeJS.Timeout | null = null;
            let timeout: NodeJS.Timeout | null = null;

            const cleanup = () => {
                if (interval) {
                    clearInterval(interval);
                    interval = null;
                }
                if (timeout) {
                    clearTimeout(timeout);
                    timeout = null;
                }
            };

            const resolveOnce = (value: string, isTimeout = false) => {
                if (resolved) return;
                resolved = true;
                cleanup();
                if (isTimeout) timeoutReached = true;
                resolve(value);
            };

            // Setup an interval to poll for output
            interval = setInterval(() => {
                const newOutput = terminalManager.getNewOutput(pid);
                if (newOutput && newOutput.length > 0) {
                    resolveOnce(newOutput);
                }
            }, 300); // Check every 300ms

            // Set a timeout to stop waiting
            timeout = setTimeout(() => {
                const finalOutput = terminalManager.getNewOutput(pid) || "";
                resolveOnce(finalOutput, true);
            }, timeout_ms);
        });

        output = await outputPromise;
    } catch (error) {
        return {
            content: [{ type: "text", text: `Error reading output: ${error}` }],
            isError: true,
        };
    }

  return {
    content: [{
      type: "text",
      text: output || 'No new output available' + (timeoutReached ? ' (timeout reached)' : '')
    }],
  };
}

export async function forceTerminate(args: unknown): Promise<ServerResult> {
  const parsed = ForceTerminateArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      content: [{ type: "text", text: `Error: Invalid arguments for force_terminate: ${parsed.error}` }],
      isError: true,
    };
  }

  const success = terminalManager.forceTerminate(parsed.data.pid);
  return {
    content: [{
      type: "text",
      text: success
        ? `Successfully initiated termination of session ${parsed.data.pid}`
        : `No active session found for PID ${parsed.data.pid}`
    }],
  };
}

export async function listSessions() {
  const sessions = terminalManager.listActiveSessions();
  return {
    content: [{
      type: "text",
      text: sessions.length === 0
        ? 'No active sessions'
        : sessions.map(s =>
            `PID: ${s.pid}, Blocked: ${s.isBlocked}, Runtime: ${Math.round(s.runtime / 1000)}s`
          ).join('\n')
    }],
  };
}
