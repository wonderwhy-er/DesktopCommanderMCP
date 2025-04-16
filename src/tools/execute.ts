import { terminalManager } from '../terminal-manager.js';
import { commandManager } from '../command-manager.js';
import { ExecuteCommandArgsSchema, ReadOutputArgsSchema, ForceTerminateArgsSchema, ListSessionsArgsSchema } from './schemas.js';
import { capture } from "../utils.js";
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
    const commands = commandManager.extractCommands(parsed.data.command);
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

  const output = terminalManager.getNewOutput(parsed.data.pid);
  return {
    content: [{
      type: "text",
      text: output === null
        ? `No session found for PID ${parsed.data.pid}`
        : output || 'No new output available'
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
