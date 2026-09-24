import { terminalManager, MAX_BUFFERED_OUTPUT_CHARS, getProcessWaitLimit } from '../terminal-manager.js';
import { commandManager } from '../command-manager.js';
import { StartProcessArgsSchema, ReadProcessOutputArgsSchema, InteractWithProcessArgsSchema, ForceTerminateArgsSchema, ListSessionsArgsSchema } from './schemas.js';
import { capture } from "../utils/capture.js";
import { ServerResult } from '../types.js';
import { analyzeProcessState, cleanProcessOutput, formatProcessStateMessage, ProcessState } from '../utils/process-detection.js';
import { configManager } from '../config-manager.js';
import { getDefaultShell } from '../utils/shell.js';
import { terminateProcessTree } from '../utils/process-tree.js';
import { MAX_PROCESS_WAIT_MS } from '../config.js';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the directory where the MCP is installed (for ES module imports)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mcpRoot = path.resolve(__dirname, '..', '..');

// Track virtual Node sessions (PIDs that are actually Node fallback sessions)
const virtualNodeSessions = new Map<number, { timeout_ms: number }>();
let virtualPidCounter = -1000; // Use negative PIDs for virtual sessions

/** The answer when some processes of a session could not be ended */
function terminationFailedResult(pid: number): ServerResult {
  return {
    content: [{ type: "text", text: `Error: Could not terminate every process of session ${pid}; some may still be running` }],
    isError: true,
  };
}

/**
 * Execute Node.js code via temp file (fallback when Python unavailable)
 * Creates temp .mjs file in MCP directory for ES module import access
 */
async function executeNodeCode(code: string, timeout_ms: number = 30000, sessionPid: number): Promise<ServerResult> {
  const tempFile = path.join(mcpRoot, `.mcp-exec-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);

  try {
    await fs.writeFile(tempFile, code, 'utf8');

    const result = await new Promise<{ stdout: string; stderr: string; exitCode: number; treeSurvived?: boolean }>((resolve) => {
      const proc = spawn(process.execPath, [tempFile], {
        cwd: mcpRoot,
        windowsHide: true  // Prevent visible console windows on Windows
      });

      let stdout = '';
      let stderr = '';

      // Not spawn's own timeout option: that kills only the script, leaving the
      // processes it started running and holding its output pipes open, so
      // 'close' never came and the call never returned.
      const timer = setTimeout(async () => {
        if (!(await terminateProcessTree(proc))) {
          // Some of the tree survived and may keep the output pipes open, so
          // 'close' may never come: answer now and stop reading from them
          proc.stdout.destroy();
          proc.stderr.destroy();
          resolve({ stdout, stderr, exitCode: 1, treeSurvived: true });
        }
      }, timeout_ms);

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (exitCode) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({ stdout, stderr: stderr + '\n' + err.message, exitCode: 1 });
      });
    });

    // Clean up temp file
    await fs.unlink(tempFile).catch(() => {});

    if (result.treeSurvived) {
      return terminationFailedResult(sessionPid);
    }

    if (result.exitCode !== 0) {
      return {
        content: [{
          type: "text",
          text: `Execution failed (exit code ${result.exitCode}):\n${result.stderr}\n${result.stdout}`
        }],
        isError: true
      };
    }

    // Each call runs a fresh script and the session waits for the next one; the output isn't cut
    const outputLines = result.stdout.trim().length > 0 ? result.stdout.replace(/\r?\n$/, '').split('\n').length : 0;
    return {
      content: [{
        type: "text",
        text: result.stdout || '(no output)'
      }],
      structuredContent: {
        pid: sessionPid,
        status: 'waiting_for_input',
        truncated: false,
        shownLines: outputLines,
        totalLines: outputLines,
      },
    };

  } catch (error) {
    // Clean up temp file on error
    await fs.unlink(tempFile).catch(() => {});

    return {
      content: [{
        type: "text",
        text: `Failed to execute Node.js code: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
}

/**
 * Start a new process (renamed from execute_command)
 * Includes early detection of process waiting for input
 * maxWaitMs: ceiling for this call's wait. The tools always use MAX_PROCESS_WAIT_MS;
 * only in-process callers (tests) pass a smaller one. Not part of the tool schema.
 */
export async function startProcess(args: unknown, maxWaitMs: number = MAX_PROCESS_WAIT_MS): Promise<ServerResult> {
  const parsed = StartProcessArgsSchema.safeParse(args);
  if (!parsed.success) {
    capture('server_start_process_failed');
    return {
      content: [{ type: "text", text: `Error: Invalid arguments for start_process: ${parsed.error}` }],
      isError: true,
    };
  }

  try {
    // Each command's first word as typed, so telemetry replaces a path whole
    // (the base name alone would send the last part of it)
    const commands = commandManager.extractCommands(parsed.data.command, true).join(', ');
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
      structuredContent: { blocked: true, command: parsed.data.command },
    };
  }

  const commandToRun = parsed.data.command;

  // Handle node:local - runs Node.js code directly on MCP server
  if (commandToRun.trim() === 'node:local') {
    const virtualPid = virtualPidCounter--;
    virtualNodeSessions.set(virtualPid, { timeout_ms: parsed.data.timeout_ms || 30000 });

    return {
      content: [{
        type: "text",
        text: `Node.js session started with PID ${virtualPid} (MCP server execution)

   IMPORTANT: Each interact_with_process call runs as a FRESH script.
   State is NOT preserved between calls. Include ALL code in ONE call:
   - imports, file reading, processing, and output together.

   Available libraries:
   - ExcelJS for Excel files: import ExcelJS from 'exceljs'
   - All Node.js built-ins: fs, path, http, crypto, etc.

🔄 Ready for code - send complete self-contained script via interact_with_process.`
      }],
      structuredContent: { pid: virtualPid, status: 'waiting_for_input' },
    };
  }

  let shellUsed: string | undefined = parsed.data.shell;

  if (!shellUsed) {
    const config = await configManager.getConfig();
    shellUsed = config.defaultShell || getDefaultShell();
  }

  const result = await terminalManager.executeCommand(
    commandToRun,
    parsed.data.timeout_ms,
    shellUsed,
    parsed.data.verbose_timing || false,
    maxWaitMs
  );

  if (result.pid === -1) {
    return {
      content: [{ type: "text", text: result.output }],
      isError: true,
    };
  }

  // Whether the process is waiting for input, as detected when the wait ended
  const { processState } = result;

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
    structuredContent: {
      pid: result.pid,
      shell: shellUsed,
      status: getProcessStatus(processState),
      ...getWaitCapFields(result.waitCappedAtMs),
    },
  };
}

type ProcessStatus = 'waiting_for_input' | 'finished' | 'running' | 'timeout';

/**
 * Machine-readable process state for structuredContent, mirroring the
 * status line shown in the text response.
 */
function getProcessStatus(state: ProcessState, timedOut = false): ProcessStatus {
  if (state.isWaitingForInput) return 'waiting_for_input';
  if (state.isFinished) return 'finished';
  return timedOut ? 'timeout' : 'running';
}

/**
 * structuredContent fields telling the caller whether the wait ceiling
 * (not timeout_ms) ended the wait. When it did, status is 'running'
 * and the caller continues with read_process_output.
 */
function getWaitCapFields(waitCappedAtMs: number | undefined): { waitCapped: boolean; waitLimitMs?: number } {
  return waitCappedAtMs !== undefined
    ? { waitCapped: true, waitLimitMs: waitCappedAtMs }
    : { waitCapped: false };
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
 * Read output from a running process with file-like pagination
 * Supports offset/length parameters for controlled reading
 * maxWaitMs: ceiling for this call's wait. The tools always use MAX_PROCESS_WAIT_MS;
 * only in-process callers (tests) pass a smaller one. Not part of the tool schema.
 */
export async function readProcessOutput(args: unknown, maxWaitMs: number = MAX_PROCESS_WAIT_MS): Promise<ServerResult> {
  const parsed = ReadProcessOutputArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      content: [{ type: "text", text: `Error: Invalid arguments for read_process_output: ${parsed.error}` }],
      isError: true,
    };
  }

  // Get default line limit from config
  const config = await configManager.getConfig();
  const defaultLength = config.fileReadLineLimit ?? 1000;

  const { 
    pid, 
    timeout_ms = 5000, 
    offset = 0,                    // 0 = from last read, positive = absolute, negative = tail
    length = defaultLength,        // Default from config, same as file reading
    verbose_timing = false 
  } = parsed.data;

  // Timing telemetry
  const startTime = Date.now();
  const { waitMs } = getProcessWaitLimit(timeout_ms, maxWaitMs);

  // For active sessions with no new output yet, optionally wait for output
  const session = terminalManager.getSession(pid);
  if (session && offset === 0) {
    // Wait for new output to arrive (only for "new output" reads, not absolute/tail)
    const waitForOutput = (): Promise<void> => {
      return new Promise((resolve) => {
        // Check if there's already new output
        if (terminalManager.hasUnreadOutput(pid)) {
          resolve();
          return;
        }

        let resolved = false;
        let interval: NodeJS.Timeout | null = null;
        let timeout: NodeJS.Timeout | null = null;

        const cleanup = () => {
          if (interval) clearInterval(interval);
          if (timeout) clearTimeout(timeout);
        };

        const resolveOnce = () => {
          if (resolved) return;
          resolved = true;
          cleanup();
          resolve();
        };

        // Poll for new output, or for the exit (the session is then no
        // longer active): a process that exited writes nothing more itself
        interval = setInterval(() => {
          if (terminalManager.hasUnreadOutput(pid) || !terminalManager.getSession(pid)) {
            resolveOnce();
          }
        }, 50);

        // Timeout
        timeout = setTimeout(() => {
          resolveOnce();
        }, waitMs);
      });
    };

    await waitForOutput();
  }

  // Read output with pagination
  const result = terminalManager.readOutputPaginated(pid, offset, length);
  
  if (!result) {
    return {
      content: [{ type: "text", text: `No session found for PID ${pid}` }],
      isError: true,
    };
  }

  // Join lines back into string
  const output = result.lines.join('\n');

  // Generate status message similar to file reading
  let statusMessage = '';
  if (offset < 0) {
    // Tail read - match file reading format for consistency
    statusMessage = `[Reading last ${result.readCount} lines (total: ${result.totalLines} lines)]`;
  } else if (offset === 0) {
    // "New output" read
    if (result.remaining > 0) {
      statusMessage = `[Reading ${result.readCount} new lines from line ${result.readFrom} (total: ${result.totalLines} lines, ${result.remaining} remaining)]`;
    } else {
      statusMessage = `[Reading ${result.readCount} new lines (total: ${result.totalLines} lines)]`;
    }
  } else {
    // Absolute position read
    statusMessage = `[Reading ${result.readCount} lines from line ${result.readFrom} (total: ${result.totalLines} lines, ${result.remaining} remaining)]`;
  }

  // Surface buffer-cap eviction so the model knows the retained output is not
  // the full output and that line numbers shifted (matches the truncation
  // markers used by other tools).
  if (result.evictedLines && result.evictedLines > 0) {
    const capMB = Math.round(MAX_BUFFERED_OUTPUT_CHARS / 1024 / 1024);
    statusMessage += `\n[WARNING: output exceeded the ${capMB}MB buffer cap; the ${result.evictedLines} earliest lines were evicted and cannot be read. Line numbers and totals refer to the retained buffer only]`;
  }

  // Add process state info
  let processStateMessage = '';
  if (result.isComplete) {
    const runtimeStr = result.runtimeMs !== undefined 
      ? ` (runtime: ${(result.runtimeMs / 1000).toFixed(2)}s)` 
      : '';
    // A process ended by a signal has no exit code: name the signal instead of "exit code null"
    const ending = result.exitCode === null && result.signal ? `signal ${result.signal}` : `exit code ${result.exitCode}`;
    processStateMessage = `\n✅ Process completed with ${ending}${runtimeStr}`;
  } else if (session) {
    // Analyze state for running processes
    const processState = terminalManager.getProcessState(pid);
    if (processState?.isWaitingForInput) {
      processStateMessage = `\n🔄 ${formatProcessStateMessage(processState, pid)}`;
    }
  }

  // Add timing information if requested
  let timingMessage = '';
  if (verbose_timing) {
    const endTime = Date.now();
    timingMessage = `\n\n📊 Timing: ${endTime - startTime}ms`;
  }

  const responseText = output || '(No output in requested range)';

  return {
    content: [{
      type: "text",
      text: `${statusMessage}\n\n${responseText}${processStateMessage}${timingMessage}`
    }],
  };
}

/**
 * Interact with a running process (renamed from send_input)
 * Automatically detects when process is ready and returns output
 * maxWaitMs: ceiling for this call's wait. The tools always use MAX_PROCESS_WAIT_MS;
 * only in-process callers (tests) pass a smaller one. Not part of the tool schema.
 */
export async function interactWithProcess(args: unknown, maxWaitMs: number = MAX_PROCESS_WAIT_MS): Promise<ServerResult> {
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

  // Get config for output line limit
  const config = await configManager.getConfig();
  const maxOutputLines = config.fileReadLineLimit ?? 1000;
  const waitLimit = getProcessWaitLimit(timeout_ms, maxWaitMs);

  // Check if this is a virtual Node session (node:local)
  if (virtualNodeSessions.has(pid)) {
    const session = virtualNodeSessions.get(pid)!;
    capture('server_interact_with_process_node_fallback', {
      pid: pid,
      inputLength: input.length
    });

    // Execute code via temp file approach
    // Respect per-call timeout if provided, otherwise use session default
    // (parsed.data's: timeout_ms above already holds the 8000ms default for processes),
    // within the process wait ceiling: the call answers only once the script ends
    const effectiveTimeout = Math.min(parsed.data.timeout_ms ?? session.timeout_ms, waitLimit.capMs);
    return executeNodeCode(input, effectiveTimeout, pid);
  }

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

    // Capture output snapshot BEFORE sending input
    // This handles REPLs where output is appended to the prompt line
    const outputSnapshot = terminalManager.captureOutputSnapshot(pid);
    // Only a process that reads its input at a prompt prints prompts in its output
    const readAtPrompt = terminalManager.getProcessState(pid)?.isWaitingForInput ?? false;

    // No snapshot means no active session, which can't take input either
    const success = outputSnapshot !== null && terminalManager.sendInputToProcess(pid, input);

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
        // Not waited for: no output was read
        structuredContent: { pid, status: 'running', truncated: false, shownLines: 0, totalLines: 0 },
      };
    }

    // Smart waiting with immediate and periodic detection
    let output = "";
    let processState: ProcessState | undefined;
    let earlyExit = false;
    let waitCapped = false;

    const waitForResponse = (): Promise<void> => {
      return new Promise((resolve) => {
        let resolved = false;
        const pollIntervalMs = 50; // Poll every 50ms for faster response
        // A deadline, not a poll count, so a busy event loop can't stretch the wait past the ceiling
        const deadline = Date.now() + waitLimit.waitMs;
        let interval: NodeJS.Timeout | null = null;
        // Advances every poll, so each poll reads only the output that arrived since the
        // previous one (snapshot-based, which handles REPL prompt line appending)
        let readPosition = outputSnapshot;

        let resolveOnce = () => {
          if (resolved) return;
          resolved = true;
          if (interval) clearInterval(interval);
          resolve();
        };

        // Fast-polling check - check every 50ms for quick responses
        interval = setInterval(() => {
          if (resolved) return;

          const read = terminalManager.readOutputSince(pid, readPosition);
          if (read) readPosition = read.next;
          const newOutput = read?.output ?? '';

          if (newOutput.length > 0) {
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

            // Full output since the snapshot, bounded like the session buffer it came from
            output += newOutput;
            if (output.length > MAX_BUFFERED_OUTPUT_CHARS) {
              output = output.slice(-MAX_BUFFERED_OUTPUT_CHARS);
            }

            // Analyze current state from the end of the output since the snapshot
            processState = terminalManager.getProcessState(pid, outputSnapshot) ?? analyzeProcessState(output, pid);

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
          }

          // Also exit once the process has exited, whether or not it wrote
          // anything since the previous poll: no answer can come any more
          const state = terminalManager.getProcessState(pid, outputSnapshot);
          if (state?.isFinished) {
            processState = state;
            exitReason = 'process_finished';
            resolveOnce();
            return;
          }

          if (Date.now() >= deadline) {
            exitReason = 'timeout';
            waitCapped = waitLimit.capped;
            resolveOnce();
          }
        }, pollIntervalMs);
      });
    };
    
    await waitForResponse();

    // Clean and format output
    let cleanOutput = cleanProcessOutput(output, input, readAtPrompt);
    const timeoutReached = !earlyExit && !processState?.isFinished && !processState?.isWaitingForInput;
    
    // Apply output line limit to prevent context overflow
    let truncationMessage = '';
    const outputLines = cleanOutput.split('\n');
    const totalLines = cleanOutput.trim().length > 0 ? outputLines.length : 0;
    const shownLines = Math.min(totalLines, maxOutputLines);
    if (outputLines.length > maxOutputLines) {
      const truncatedLines = outputLines.slice(0, maxOutputLines);
      cleanOutput = truncatedLines.join('\n');
      const remainingLines = outputLines.length - maxOutputLines;
      truncationMessage = `\n\n⚠️ Output truncated: showing ${maxOutputLines} of ${outputLines.length} lines (${remainingLines} hidden). Use read_process_output with offset/length for full output.`;
    }
    
    // Determine final state
    if (!processState) {
      processState = terminalManager.getProcessState(pid, outputSnapshot) ?? analyzeProcessState(output, pid);
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

    // A capped wait didn't reach the caller's timeout_ms: the process is still
    // running and the caller continues with read_process_output
    const structuredContent = {
      pid,
      status: getProcessStatus(processState, timeoutReached && !waitCapped),
      truncated: totalLines > shownLines,
      shownLines,
      totalLines,
      ...getWaitCapFields(timeoutReached && waitCapped ? waitLimit.capMs : undefined),
    };

    if (cleanOutput.trim().length === 0 && !timeoutReached) {
      return {
        content: [{
          type: "text",
          text: `✅ Input executed in process ${pid}.\n📭 (No output produced)${statusMessage}${timingMessage}`
        }],
        structuredContent,
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

    if (truncationMessage) {
      responseText += truncationMessage;
    }

    if (timingMessage) {
      responseText += timingMessage;
    }

    return {
      content: [{
        type: "text",
        text: responseText
      }],
      structuredContent,
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

  const pid = parsed.data.pid;

  // Handle virtual Node.js sessions (node:local)
  if (virtualNodeSessions.has(pid)) {
    virtualNodeSessions.delete(pid);
    return {
      content: [{
        type: "text",
        text: `Cleared virtual Node.js session ${pid}`
      }],
    };
  }

  // Returns once the session's processes are gone, so a success means they no longer run
  const outcome = await terminalManager.forceTerminate(pid);
  if (outcome === 'failed') {
    return terminationFailedResult(pid);
  }
  return {
    content: [{
      type: "text",
      text: outcome === 'terminated'
        ? `Successfully initiated termination of session ${pid}`
        : `No active session found for PID ${pid}`
    }],
  };
}

/**
 * List active sessions
 */
export async function listSessions(): Promise<ServerResult> {
  const sessions = terminalManager.listActiveSessions();

  // Include virtual Node.js sessions
  const virtualSessions = Array.from(virtualNodeSessions.entries()).map(([pid, session]) => ({
    pid,
    type: 'node:local',
    timeout_ms: session.timeout_ms
  }));

  const realSessionsText = sessions.map(s =>
    `PID: ${s.pid}, Blocked: ${s.isBlocked}, Runtime: ${Math.round(s.runtime / 1000)}s`
  );

  const virtualSessionsText = virtualSessions.map(s =>
    `PID: ${s.pid} (node:local), Timeout: ${s.timeout_ms}ms`
  );

  const allSessions = [...realSessionsText, ...virtualSessionsText];

  return {
    content: [{
      type: "text",
      text: allSessions.length === 0
        ? 'No active sessions'
        : allSessions.join('\n')
    }],
    structuredContent: {
      sessions: [
        ...sessions.map(s => ({ pid: s.pid, type: 'process', isBlocked: s.isBlocked, runtimeMs: s.runtime })),
        ...virtualSessions.map(s => ({ pid: s.pid, type: s.type, timeoutMs: s.timeout_ms })),
      ],
    },
  };
}