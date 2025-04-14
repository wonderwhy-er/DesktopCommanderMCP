import { spawn } from 'child_process';
import { TerminalSession, CommandExecutionResult, ActiveSession } from './types.js';
import { DEFAULT_COMMAND_TIMEOUT } from './config.js';
import {capture} from "./utils.js";

interface CompletedSession {
  pid: number;
  output: string;
  exitCode: number | null;
  startTime: Date;
  endTime: Date;
}

export class TerminalManager {
  private sessions: Map<number, TerminalSession> = new Map();
  private completedSessions: Map<number, CompletedSession> = new Map();
  
  async executeCommand(command: string, timeoutMs: number = DEFAULT_COMMAND_TIMEOUT): Promise<CommandExecutionResult> {
    const process = spawn(command, [], { shell: true });
    let output = '';
    
    // Ensure process.pid is defined before proceeding
    if (!process.pid) {
      // Return a consistent error object instead of throwing
      return {
        pid: -1,  // Use -1 to indicate an error state
        output: 'Error: Failed to get process ID. The command could not be executed.',
        isBlocked: false
      };
    }
    
    const session: TerminalSession = {
      pid: process.pid,
      process,
      lastOutput: '',
      isBlocked: false,
      startTime: new Date()
    };
    
    this.sessions.set(process.pid, session);

    return new Promise((resolve) => {
      process.stdout.on('data', (data) => {
        const text = data.toString();
        output += text;
        session.lastOutput += text;
      });

      process.stderr.on('data', (data) => {
        const text = data.toString();
        output += text;
        session.lastOutput += text;
      });

      setTimeout(() => {
        session.isBlocked = true;
        resolve({
          pid: process.pid!,
          output,
          isBlocked: true
        });
      }, timeoutMs);

      process.on('exit', (code) => {
        if (process.pid) {
          // Store completed session before removing active session
          this.completedSessions.set(process.pid, {
            pid: process.pid,
            output: output + session.lastOutput, // Combine all output
            exitCode: code,
            startTime: session.startTime,
            endTime: new Date()
          });
          
          // Keep only last 100 completed sessions
          if (this.completedSessions.size > 100) {
            const oldestKey = Array.from(this.completedSessions.keys())[0];
            this.completedSessions.delete(oldestKey);
          }
          
          this.sessions.delete(process.pid);
        }
        resolve({
          pid: process.pid!,
          output,
          isBlocked: false
        });
      });
    });
  }

  getNewOutput(pid: number): string | null {
    // First check active sessions
    const session = this.sessions.get(pid);
    if (session) {
      const output = session.lastOutput;
      session.lastOutput = '';
      return output;
    }

    // Then check completed sessions
    const completedSession = this.completedSessions.get(pid);
    if (completedSession) {
      // Format completion message with exit code and runtime
      const runtime = (completedSession.endTime.getTime() - completedSession.startTime.getTime()) / 1000;
      return `Process completed with exit code ${completedSession.exitCode}\nRuntime: ${runtime}s\nFinal output:\n${completedSession.output}`;
    }

    return null;
  }

  forceTerminate(pid: number): boolean {
    const session = this.sessions.get(pid);
    if (!session) {
      return false;
    }

    try {
      session.process.kill('SIGINT');
      setTimeout(() => {
        if (this.sessions.has(pid)) {
          session.process.kill('SIGKILL');
        }
      }, 1000);
      return true;
    } catch (error) {
      capture('server_request_error', {error: error, message:`Failed to terminate process ${pid}:`});
      return false;
    }
  }

  listActiveSessions(): ActiveSession[] {
    const now = new Date();
    return Array.from(this.sessions.values()).map(session => ({
      pid: session.pid,
      isBlocked: session.isBlocked,
      runtime: now.getTime() - session.startTime.getTime()
    }));
  }

  listCompletedSessions(): CompletedSession[] {
    return Array.from(this.completedSessions.values());
  }
}

export const terminalManager = new TerminalManager();