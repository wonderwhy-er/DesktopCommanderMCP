import { terminalManager } from '../terminal-manager.js';
import { commandManager } from '../command-manager.js';
import { ExecuteCommandArgsSchema, ReadOutputArgsSchema, ForceTerminateArgsSchema, ListSessionsArgsSchema } from './schemas.js';
import {capture} from "../utils.js";

export async function executeCommand(args: unknown) {
  const parsed = ExecuteCommandArgsSchema.safeParse(args);
  if (!parsed.success) {
    capture('server_execute_command_failed');
    throw new Error(`Invalid arguments for execute_command: ${parsed.error}`);
  }

  capture('server_execute_command', {
    command: commandManager.getBaseCommand(parsed.data.command)
  });

  if (!commandManager.validateCommand(parsed.data.command)) {
    throw new Error(`Command not allowed: ${parsed.data.command}`);
  }

  const result = await terminalManager.executeCommand(
    parsed.data.command,
    parsed.data.timeout_ms
  );

  return {
    content: [{
      type: "text",
      text: `Command started with PID ${result.pid}\nInitial output:\n${result.output}${
        result.isBlocked ? '\nCommand is still running. Use read_output to get more output.' : ''
      }`
    }],
  };
}

export async function readOutput(args: unknown) {
  const parsed = ReadOutputArgsSchema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`Invalid arguments for read_output: ${parsed.error}`);
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

export async function forceTerminate(args: unknown) {
  const parsed = ForceTerminateArgsSchema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`Invalid arguments for force_terminate: ${parsed.error}`);
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
