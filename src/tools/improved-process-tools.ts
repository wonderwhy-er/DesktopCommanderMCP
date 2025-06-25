import { terminalManager } from '../terminal-manager.js';
import { commandManager } from '../command-manager.js';
import { StartProcessArgsSchema, ReadProcessOutputArgsSchema, InteractWithProcessArgsSchema, ForceTerminateArgsSchema, ListSessionsArgsSchema } from './schemas.js';
import { capture } from "../utils/capture.js";
import { ServerResult } from '../types.js';
import { analyzeProcessState, cleanProcessOutput, formatProcessStateMessage } from '../utils/process-detection.js';

/**
 * Start a new process (renamed from execute_command)
 * Includes early detection of process waiting for input
 */
export async function startProcess(args: unknown): Promise<ServerResult> {
  const parsed = StartProcessArgsSchema.safeParse(args);
  if (!parsed.success) {
    capture('server_start_process_failed');
    return {
      content: [{ type: "text", text: `Error: Invalid arguments for start_process: ${parsed.error}` }],
      isError: true,
    };
  }

  try {
    const commands = commandManager.extractCommands(parsed.data.command).join(', ');
    capture('server_start_process', {
      command: commandManager.getBaseCommand(parsed.data.command),
      commands: commands
    });
  } catch (error) {
    capture('server_start_process', {
      command: commandManager.getBaseCommand(parsed.data.command)
    });
  }

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

  if (result.pid === -1) {
    return {
      content: [{ type: "text", text: result.output }],
      isError: true,
    };
  }

  // Analyze the process state to detect if it's waiting for input
  const processState = analyzeProcessState(result.output, result.pid);
  
  let statusMessage = '';
  if (processState.isWaitingForInput) {
    statusMessage = `\n🔄 ${formatProcessStateMessage(processState, result.pid)}`;
  } else if (processState.isFinished) {
    statusMessage = `\n✅ ${formatProcessStateMessage(processState, result.pid)}`;
  } else if (result.isBlocked) {
    statusMessage = '\n⏳ Process is running. Use read_process_output to get more output.';
  }

  return {
    content: [{
      type: "text",
      text: `Process started with PID ${result.pid}\nInitial output:\n${result.output}${statusMessage}`
    }],
  };
}

/**
 * Read output from a running process (renamed from read_output)
 * Includes early detection of process waiting for input
 */
export async function readProcessOutput(args: unknown): Promise<ServerResult> {
  const parsed = ReadProcessOutputArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      content: [{ type: "text", text: `Error: Invalid arguments for read_process_output: ${parsed.error}` }],
      isError: true,
    };
  }

  const { pid, timeout_ms = 5000 } = parsed.data;

  const session = terminalManager.getSession(pid);
  if (!session) {
    return {
      content: [{ type: "text", text: `No active session found for PID ${pid}` }],
      isError: true,
    };
  }

  let output = "";
  let timeoutReached = false;
  let earlyExit = false;
  let processState;

  try {
    const outputPromise: Promise<string> = new Promise<string>((resolve) => {
      const initialOutput = terminalManager.getNewOutput(pid);
      if (initialOutput && initialOutput.length > 0) {
        resolve(initialOutput);
        return;
      }

      let resolved = false;
      let interval: NodeJS.Timeout | null = null;
      let timeout: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (interval) clearInterval(interval);
        if (timeout) clearTimeout(timeout);
      };

      const resolveOnce = (value: string, isTimeout = false) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        timeoutReached = isTimeout;
        resolve(value);
      };

      interval = setInterval(() => {
        const newOutput = terminalManager.getNewOutput(pid);
        if (newOutput && newOutput.length > 0) {
          const currentOutput = output + newOutput;
          const state = analyzeProcessState(currentOutput, pid);
          
          // Early exit if process is clearly waiting for input
          if (state.isWaitingForInput) {
            earlyExit = true;
            processState = state;
            resolveOnce(newOutput);
            return;
          }
          
          output = currentOutput;
          
          // Continue collecting if still running
          if (!state.isFinished) {
            return;
          }
          
          // Process finished
          processState = state;
          resolveOnce(newOutput);
        }
      }, 200); // Check every 200ms

      timeout = setTimeout(() => {
        const finalOutput = terminalManager.getNewOutput(pid) || "";
        resolveOnce(finalOutput, true);
      }, timeout_ms);
    });

    const newOutput = await outputPromise;
    output += newOutput;
    
    // Analyze final state if not already done
    if (!processState) {
      processState = analyzeProcessState(output, pid);
    }

  } catch (error) {
    return {
      content: [{ type: "text", text: `Error reading output: ${error}` }],
      isError: true,
    };
  }

  // Format response based on what we detected
  let statusMessage = '';
  if (earlyExit && processState?.isWaitingForInput) {
    statusMessage = `\n🔄 ${formatProcessStateMessage(processState, pid)}`;
  } else if (processState?.isFinished) {
    statusMessage = `\n✅ ${formatProcessStateMessage(processState, pid)}`;
  } else if (timeoutReached) {
    statusMessage = '\n⏱️ Timeout reached - process may still be running';
  }

  const responseText = output || 'No new output available';
  
  return {
    content: [{
      type: "text",
      text: `${responseText}${statusMessage}`
    }],
  };
}

/**
 * Interact with a running process (renamed from send_input)
 * Automatically detects when process is ready and returns output
 */
export async function interactWithProcess(args: unknown): Promise<ServerResult> {
  const parsed = InteractWithProcessArgsSchema.safeParse(args);
  if (!parsed.success) {
    capture('server_interact_with_process_failed', {
      error: 'Invalid arguments'
    });
    return {
      content: [{ type: "text", text: `Error: Invalid arguments for interact_with_process: ${parsed.error}` }],
      isError: true,
    };
  }

  const { 
    pid, 
    input, 
    timeout_ms = 8000,
    wait_for_prompt = true
  } = parsed.data;
  
  try {
    capture('server_interact_with_process', {
      pid: pid,
      inputLength: input.length
    });

    const success = terminalManager.sendInputToProcess(pid, input);
    
    if (!success) {
      return {
        content: [{ type: "text", text: `Error: Failed to send input to process ${pid}. The process may have exited or doesn't accept input.` }],
        isError: true,
      };
    }

    // If not waiting for response, return immediately
    if (!wait_for_prompt) {
      return {
        content: [{
          type: "text",
          text: `✅ Input sent to process ${pid}. Use read_process_output to get the response.`
        }],
      };
    }

    // Smart waiting with process state detection
    let output = "";
    let attempts = 0;
    const maxAttempts = Math.ceil(timeout_ms / 200);
    let processState;
    
    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const newOutput = terminalManager.getNewOutput(pid);
      if (newOutput && newOutput.length > 0) {
        output += newOutput;
        
        // Analyze current state
        processState = analyzeProcessState(output, pid);
        
        // Exit early if we detect the process is waiting for input
        if (processState.isWaitingForInput) {
          break;
        }
        
        // Also exit if process finished
        if (processState.isFinished) {
          break;
        }
      }
      
      attempts++;
    }

    // Clean and format output
    const cleanOutput = cleanProcessOutput(output, input);
    const timeoutReached = attempts >= maxAttempts;
    
    // Determine final state
    if (!processState) {
      processState = analyzeProcessState(output, pid);
    }
    
    let statusMessage = '';
    if (processState.isWaitingForInput) {
      statusMessage = `\n🔄 ${formatProcessStateMessage(processState, pid)}`;
    } else if (processState.isFinished) {
      statusMessage = `\n✅ ${formatProcessStateMessage(processState, pid)}`;
    } else if (timeoutReached) {
      statusMessage = '\n⏱️ Response may be incomplete (timeout reached)';
    }
    
    if (cleanOutput.trim().length === 0 && !timeoutReached) {
      return {
        content: [{
          type: "text",
          text: `✅ Input executed in process ${pid}.\n(No output produced)${statusMessage}`
        }],
      };
    }
    
    return {
      content: [{
        type: "text", 
        text: `✅ Input executed in process ${pid}:\n\n${cleanOutput}${statusMessage}`
      }],
    };
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    capture('server_interact_with_process_error', {
      error: errorMessage
    });
    return {
      content: [{ type: "text", text: `Error interacting with process: ${errorMessage}` }],
      isError: true,
    };
  }
}

/**
 * Force terminate a process
 */
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

/**
 * List active sessions
 */
export async function listSessions(): Promise<ServerResult> {
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