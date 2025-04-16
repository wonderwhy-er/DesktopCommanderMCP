import { spawn } from 'child_process';
import { TerminalSession, CommandExecutionResult, ActiveSession } from './types.js';
import { DEFAULT_COMMAND_TIMEOUT } from './config.js';
import { configManager } from './config-manager.js';
import { capture } from "./utils.js";
import { executeSandboxedCommand, isSandboxAvailable } from './sandbox/index.js';
import os from 'os';

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
  
  async executeCommand(command: string, timeoutMs: number = DEFAULT_COMMAND_TIMEOUT, shell?: string): Promise<CommandExecutionResult> {
    // Get the configuration
    let config;
    try {
      config = await configManager.getConfig();
    } catch (error) {
      config = { allowedDirectories: [os.homedir()] };
    }

    // Check if sandbox execution is available and enabled
    const useSandbox = isSandboxAvailable() && config.useSandbox !== false;
    
    // Log what execution mode we're using
    console.log(`Executing command "${command}" with ${useSandbox ? 'sandbox' : 'regular'} execution`);
    
    if (useSandbox) {
      try {
        // Get the allowed directories for sandbox
        const allowedDirectories = config.allowedDirectories || [os.homedir()];
        
        // Use the platform-specific sandbox implementation
        console.log(`Executing command in sandbox: ${command}`);
        console.log(`Allowed directories: ${allowedDirectories.join(', ')}`);
        
        const result = await executeSandboxedCommand(command, timeoutMs, shell);
        
        // If sandbox execution worked, return the result
        if (result.pid !== -1) {
          console.log(`Sandbox execution successful with PID ${result.pid}`);
          return result;
        }
        
        // Otherwise fall back to regular execution
        console.warn(`Sandbox execution failed, falling back to regular execution: ${result.output}`);
      } catch (error) {
        console.error('Error in sandbox execution:', error);
        console.warn('Falling back to regular execution due to error');
      }
    }
    
    // Regular command execution (used when sandbox is not available or fails)
    // Get the shell from config if not specified
    let shellToUse: string | boolean | undefined = shell;
    if (!shellToUse) {
      shellToUse = config.defaultShell || true;
    }
    
    const spawnOptions = { 
      shell: shellToUse
    };
    
    const process = spawn(command, [], spawnOptions);
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