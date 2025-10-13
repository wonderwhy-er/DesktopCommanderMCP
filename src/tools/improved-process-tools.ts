import { terminalManager } from '../terminal-manager.js';
import { commandManager } from '../command-manager.js';
import { StartProcessArgsSchema, ReadProcessOutputArgsSchema, InteractWithProcessArgsSchema, ForceTerminateArgsSchema, ListSessionsArgsSchema } from './schemas.js';
import { capture } from "../utils/capture.js";
import { ServerResult } from '../types.js';
import { analyzeProcessState, cleanProcessOutput, formatProcessStateMessage, ProcessState } from '../utils/process-detection.js';
import { getSystemInfo } from '../utils/system-info.js';
import * as os from 'os';
import { configManager } from '../config-manager.js';

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

  let shellUsed: string | undefined = parsed.data.shell;

  if (!shellUsed) {
    const config = await configManager.getConfig();
    if (config.defaultShell) {
      shellUsed = config.defaultShell;
    } else {
      const isWindows = os.platform() === 'win32';
      if (isWindows && process.env.COMSPEC) {
        shellUsed = process.env.COMSPEC;
      } else if (!isWindows && process.env.SHELL) {
        shellUsed = process.env.SHELL;
      } else {
        shellUsed = isWindows ? 'cmd.exe' : '/bin/sh';
      }
    }
  }

  const result = await terminalManager.executeCommand(
    parsed.data.command,
    parsed.data.timeout_ms,
    shellUsed,
    parsed.data.verbose_timing || false
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

  // Add timing information if requested
  let timingMessage = '';
  if (result.timingInfo) {
    timingMessage = formatTimingInfo(result.timingInfo);
  }

  return {
    content: [{
      type: "text",
      text: `Process started with PID ${result.pid} (shell: ${shellUsed})\nInitial output:\n${result.output}${statusMessage}${timingMessage}`
    }],
  };
}

function formatTimingInfo(timing: any): string {
  let msg = '\n\n📊 Timing Information:\n';
  msg += `  Exit Reason: ${timing.exitReason}\n`;
  msg += `  Total Duration: ${timing.totalDurationMs}ms\n`;

  if (timing.timeToFirstOutputMs !== undefined) {
    msg += `  Time to First Output: ${timing.timeToFirstOutputMs}ms\n`;
  }

  if (timing.firstOutputTime && timing.lastOutputTime) {
    msg += `  Output Window: ${timing.lastOutputTime - timing.firstOutputTime}ms\n`;
  }

  if (timing.outputEvents && timing.outputEvents.length > 0) {
    msg += `\n  Output Events (${timing.outputEvents.length} total):\n`;
    timing.outputEvents.forEach((event: any, idx: number) => {
      msg += `    [${idx + 1}] +${event.deltaMs}ms | ${event.source} | ${event.length}b`;
      if (event.matchedPattern) {
        msg += ` | 🎯 ${event.matchedPattern}`;
      }
      msg += `\n       "${event.snippet}"\n`;
    });
  }

  return msg;
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

  const { pid, timeout_ms = 5000, verbose_timing = false } = parsed.data;

  const session = terminalManager.getSession(pid);
  if (!session) {
    // Check if this is a completed session
    const completedOutput = terminalManager.getNewOutput(pid);
    if (completedOutput) {
      return {
        content: [{
          type: "text",
          text: completedOutput
        }],
      };
    }

    // Neither active nor completed session found
    return {
      content: [{ type: "text", text: `No session found for PID ${pid}` }],
      isError: true,
    };
  }

  let output = "";
  let timeoutReached = false;
  let earlyExit = false;
  let processState: ProcessState | undefined;

  // Timing telemetry
  const startTime = Date.now();
  let firstOutputTime: number | undefined;
  let lastOutputTime: number | undefined;
  const outputEvents: any[] = [];
  let exitReason: 'early_exit_quick_pattern' | 'early_exit_periodic_check' | 'process_finished' | 'timeout' = 'timeout';

  try {
    const outputPromise: Promise<string> = new Promise<string>((resolve) => {
      const initialOutput = terminalManager.getNewOutput(pid);
      if (initialOutput && initialOutput.length > 0) {
        const now = Date.now();
        if (!firstOutputTime) firstOutputTime = now;
        lastOutputTime = now;

        if (verbose_timing) {
          outputEvents.push({
            timestamp: now,
            deltaMs: now - startTime,
            source: 'initial_poll',
            length: initialOutput.length,
            snippet: initialOutput.slice(0, 50).replace(/\n/g, '\\n')
          });
        }

        // Immediate check on existing output
        const state = analyzeProcessState(initialOutput, pid);
        if (state.isWaitingForInput) {
          earlyExit = true;
          processState = state;
          exitReason = 'early_exit_periodic_check';
        }
        resolve(initialOutput);
        return;
      }

      let resolved = false;
      let interval: NodeJS.Timeout | null = null;
      let timeout: NodeJS.Timeout | null = null;

      // Quick prompt patterns for immediate detection
      const quickPromptPatterns = />>>\s*$|>\s*$|\$\s*$|#\s*$/;

      const cleanup = () => {
        if (interval) clearInterval(interval);
        if (timeout) clearTimeout(timeout);
      };

      let resolveOnce = (value: string, isTimeout = false) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        timeoutReached = isTimeout;
        if (isTimeout) exitReason = 'timeout';
        resolve(value);
      };

      // Monitor for new output with immediate detection
      const session = terminalManager.getSession(pid);
      if (session && session.process && session.process.stdout && session.process.stderr) {
        const immediateDetector = (data: Buffer, source: 'stdout' | 'stderr') => {
          const text = data.toString();
          const now = Date.now();

          if (!firstOutputTime) firstOutputTime = now;
          lastOutputTime = now;

          if (verbose_timing) {
            outputEvents.push({
              timestamp: now,
              deltaMs: now - startTime,
              source,
              length: text.length,
              snippet: text.slice(0, 50).replace(/\n/g, '\\n')
            });
          }

          // Immediate check for obvious prompts
          if (quickPromptPatterns.test(text)) {
            const newOutput = terminalManager.getNewOutput(pid) || text;
            const state = analyzeProcessState(output + newOutput, pid);
            if (state.isWaitingForInput) {
              earlyExit = true;
              processState = state;
              exitReason = 'early_exit_quick_pattern';

              if (verbose_timing && outputEvents.length > 0) {
                outputEvents[outputEvents.length - 1].matchedPattern = 'quick_pattern';
              }

              resolveOnce(newOutput);
              return;
            }
          }
        };

        const stdoutDetector = (data: Buffer) => immediateDetector(data, 'stdout');
        const stderrDetector = (data: Buffer) => immediateDetector(data, 'stderr');
        session.process.stdout.on('data', stdoutDetector);
        session.process.stderr.on('data', stderrDetector);

        // Cleanup immediate detectors when done
        const originalResolveOnce = resolveOnce;
        const cleanupDetectors = () => {
          if (session.process.stdout) {
            session.process.stdout.off('data', stdoutDetector);
          }
          if (session.process.stderr) {
            session.process.stderr.off('data', stderrDetector);
          }
        };

        // Override resolveOnce to include cleanup
        const resolveOnceWithCleanup = (value: string, isTimeout = false) => {
          cleanupDetectors();
          originalResolveOnce(value, isTimeout);
        };

        // Replace the local resolveOnce reference
        resolveOnce = resolveOnceWithCleanup;
      }

      interval = setInterval(() => {
        const newOutput = terminalManager.getNewOutput(pid);
        if (newOutput && newOutput.length > 0) {
          const now = Date.now();
          if (!firstOutputTime) firstOutputTime = now;
          lastOutputTime = now;

          if (verbose_timing) {
            outputEvents.push({
              timestamp: now,
              deltaMs: now - startTime,
              source: 'periodic_poll',
              length: newOutput.length,
              snippet: newOutput.slice(0, 50).replace(/\n/g, '\\n')
            });
          }

          const currentOutput = output + newOutput;
          const state = analyzeProcessState(currentOutput, pid);

          // Early exit if process is clearly waiting for input
          if (state.isWaitingForInput) {
            earlyExit = true;
            processState = state;
            exitReason = 'early_exit_periodic_check';

            if (verbose_timing && outputEvents.length > 0) {
              outputEvents[outputEvents.length - 1].matchedPattern = 'periodic_check';
            }

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
          exitReason = 'process_finished';
          resolveOnce(newOutput);
        }
      }, 50); // Check every 50ms for faster response

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

  // Add timing information if requested
  let timingMessage = '';
  if (verbose_timing) {
    const endTime = Date.now();
    const timingInfo = {
      startTime,
      endTime,
      totalDurationMs: endTime - startTime,
      exitReason,
      firstOutputTime,
      lastOutputTime,
      timeToFirstOutputMs: firstOutputTime ? firstOutputTime - startTime : undefined,
      outputEvents: outputEvents.length > 0 ? outputEvents : undefined
    };
    timingMessage = formatTimingInfo(timingInfo);
  }

  const responseText = output || 'No new output available';

  return {
    content: [{
      type: "text",
      text: `${responseText}${statusMessage}${timingMessage}`
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
    wait_for_prompt = true,
    verbose_timing = false
  } = parsed.data;

  // Timing telemetry
  const startTime = Date.now();
  let firstOutputTime: number | undefined;
  let lastOutputTime: number | undefined;
  const outputEvents: any[] = [];
  let exitReason: 'early_exit_quick_pattern' | 'early_exit_periodic_check' | 'process_finished' | 'timeout' | 'no_wait' = 'timeout';

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
      exitReason = 'no_wait';
      let timingMessage = '';
      if (verbose_timing) {
        const endTime = Date.now();
        const timingInfo = {
          startTime,
          endTime,
          totalDurationMs: endTime - startTime,
          exitReason,
          firstOutputTime,
          lastOutputTime,
          timeToFirstOutputMs: undefined,
          outputEvents: undefined
        };
        timingMessage = formatTimingInfo(timingInfo);
      }
      return {
        content: [{
          type: "text",
          text: `✅ Input sent to process ${pid}. Use read_process_output to get the response.${timingMessage}`
        }],
      };
    }

    // Smart waiting with immediate and periodic detection
    let output = "";
    let processState: ProcessState | undefined;
    let earlyExit = false;

    // Quick prompt patterns for immediate detection
    const quickPromptPatterns = />>>\s*$|>\s*$|\$\s*$|#\s*$/;
    
    const waitForResponse = (): Promise<void> => {
      return new Promise((resolve) => {
        let resolved = false;
        let attempts = 0;
        const pollIntervalMs = 50; // Poll every 50ms for faster response
        const maxAttempts = Math.ceil(timeout_ms / pollIntervalMs);
        let interval: NodeJS.Timeout | null = null;

        let resolveOnce = () => {
          if (resolved) return;
          resolved = true;
          if (interval) clearInterval(interval);
          resolve();
        };

        // Fast-polling check - check every 50ms for quick responses
        interval = setInterval(() => {
          if (resolved) return;

          const newOutput = terminalManager.getNewOutput(pid);
          if (newOutput && newOutput.length > 0) {
            const now = Date.now();
            if (!firstOutputTime) firstOutputTime = now;
            lastOutputTime = now;

            if (verbose_timing) {
              outputEvents.push({
                timestamp: now,
                deltaMs: now - startTime,
                source: 'periodic_poll',
                length: newOutput.length,
                snippet: newOutput.slice(0, 50).replace(/\n/g, '\\n')
              });
            }

            output += newOutput;

            // Analyze current state
            processState = analyzeProcessState(output, pid);

            // Exit early if we detect the process is waiting for input
            if (processState.isWaitingForInput) {
              earlyExit = true;
              exitReason = 'early_exit_periodic_check';

              if (verbose_timing && outputEvents.length > 0) {
                outputEvents[outputEvents.length - 1].matchedPattern = 'periodic_check';
              }

              resolveOnce();
              return;
            }

            // Also exit if process finished
            if (processState.isFinished) {
              exitReason = 'process_finished';
              resolveOnce();
              return;
            }
          }

          attempts++;
          if (attempts >= maxAttempts) {
            exitReason = 'timeout';
            resolveOnce();
          }
        }, pollIntervalMs);
      });
    };
    
    await waitForResponse();

    // Clean and format output
    const cleanOutput = cleanProcessOutput(output, input);
    const timeoutReached = !earlyExit && !processState?.isFinished && !processState?.isWaitingForInput;
    
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

    // Add timing information if requested
    let timingMessage = '';
    if (verbose_timing) {
      const endTime = Date.now();
      const timingInfo = {
        startTime,
        endTime,
        totalDurationMs: endTime - startTime,
        exitReason,
        firstOutputTime,
        lastOutputTime,
        timeToFirstOutputMs: firstOutputTime ? firstOutputTime - startTime : undefined,
        outputEvents: outputEvents.length > 0 ? outputEvents : undefined
      };
      timingMessage = formatTimingInfo(timingInfo);
    }

    if (cleanOutput.trim().length === 0 && !timeoutReached) {
      return {
        content: [{
          type: "text",
          text: `✅ Input executed in process ${pid}.\n📭 (No output produced)${statusMessage}${timingMessage}`
        }],
      };
    }

    // Format response with better structure and consistent emojis
    let responseText = `✅ Input executed in process ${pid}`;

    if (cleanOutput && cleanOutput.trim().length > 0) {
      responseText += `:\n\n📤 Output:\n${cleanOutput}`;
    } else {
      responseText += `.\n📭 (No output produced)`;
    }

    if (statusMessage) {
      responseText += `\n\n${statusMessage}`;
    }

    if (timingMessage) {
      responseText += timingMessage;
    }

    return {
      content: [{
        type: "text",
        text: responseText
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