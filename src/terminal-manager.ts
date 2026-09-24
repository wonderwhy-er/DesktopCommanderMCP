import { spawn } from 'child_process';
import { TerminalSession, CommandExecutionResult, ActiveSession, TimingInfo, OutputEvent } from './types.js';
import { DEFAULT_COMMAND_TIMEOUT, MAX_PROCESS_WAIT_MS } from './config.js';
import { configManager, type ServerConfig } from './config-manager.js';
import {capture} from "./utils/capture.js";
import { analyzeProcessState, STATE_DETECTION_TAIL_CHARS, type ProcessState } from './utils/process-detection.js';
import { getDefaultShell, getShellSpawnArgs, type ShellSpawnConfig } from './utils/shell.js';

/**
 * Standard Windows PATHEXT value, used to repair a corrupted PATHEXT before
 * spawning child shells.
 *
 * On some Windows Claude Desktop / DXT launches the server process inherits a
 * broken PATHEXT (observed as ".CPL" only). Because we build the child env from
 * { ...process.env }, that broken value would propagate into every spawned
 * shell, stripping ".EXE" and breaking resolution of git / node / python / rg /
 * etc. (and even full-path .exe invocations under PowerShell). See issue #481.
 */
const STANDARD_PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC';

/**
 * Return a healthy PATHEXT for spawned Windows shells.
 * - Unset           -> use the standard list.
 * - Missing ".EXE"  -> corrupted; merge the standard list with whatever was
 *                      present (preserves any extra extensions, order-stable).
 * - Otherwise       -> leave the inherited value untouched.
 */
function getRepairedPathExt(): string {
  const current = process.env.PATHEXT;
  if (!current) return STANDARD_PATHEXT;
  const exts = current.split(';').map(e => e.trim().toUpperCase()).filter(Boolean);
  if (!exts.includes('.EXE')) {
    return [...new Set([...STANDARD_PATHEXT.split(';'), ...exts])].join(';');
  }
  return current;
}

/** A child process's output pipes. */
type OutputStream = 'stdout' | 'stderr';
const OUTPUT_STREAMS: readonly OutputStream[] = ['stdout', 'stderr'];

/** The end of one output pipe, kept for process-state detection (see getProcessState). */
interface StreamTail {
  text: string;    // Its last STATE_DETECTION_TAIL_CHARS chars
  chars: number;   // Chars it has delivered since process start
  turn: number;    // Event-loop turn that delivered its latest chunk (see currentDeliveryTurn)
}
type StreamTails = Record<OutputStream, StreamTail>;

function newStreamTails(): StreamTails {
  return { stdout: { text: '', chars: 0, turn: 0 }, stderr: { text: '', chars: 0, turn: 0 } };
}

/** An active session plus the per-stream tails that state detection reads. */
interface ManagedSession extends TerminalSession {
  streams: StreamTails;
}

interface CompletedSession {
  // The session itself, not a copy: a process the command started can keep
  // writing to the pipes after the exit, and that output lands in its buffers
  session: ManagedSession;
  exitCode: number | null;
  endTime: Date;
}

/** The retained-output fields shared by active and completed sessions. */
type OutputBuffer = Pick<ManagedSession, 'outputLines' | 'bufferedChars' | 'evictedLines' | 'evictedChars' | 'streams'>;

/**
 * A position in a session's output, absolute since process start (evicted
 * output included), so it stays valid while the buffer cap evicts lines.
 */
export interface OutputSnapshot {
  totalChars: number;
  lineCount: number;
  streamChars: Record<OutputStream, number>;  // Chars each stream had delivered, for getProcessState
}

/**
 * Ceiling for a single blocking process wait (start_process's initial wait,
 * interact_with_process, read_process_output). The wait is otherwise bounded
 * only by the caller's timeout_ms, and MCP clients abandon a tool call after
 * ~4 minutes (Claude Desktop: "No result received ... after 4 minutes"), so a
 * large timeout_ms on a long, prompt-less command used to outlive the client.
 * The ceiling is MAX_PROCESS_WAIT_MS; callers other than the tools (tests) may
 * pass a smaller one.
 */

export interface ProcessWaitLimit {
  waitMs: number;   // How long this call may block: min(timeout_ms, capMs)
  capMs: number;    // Ceiling in effect (MAX_PROCESS_WAIT_MS unless a caller passed another)
  capped: boolean;  // True when the ceiling, not timeout_ms, bounds this wait
}

/**
 * The one place that turns a caller's timeout_ms into the time a process wait
 * may actually block. When `capped`, the call returns at the ceiling with the
 * process still running and the caller continues with read_process_output.
 */
export function getProcessWaitLimit(timeoutMs: number, capMs: number = MAX_PROCESS_WAIT_MS): ProcessWaitLimit {
  return { waitMs: Math.min(timeoutMs, capMs), capMs, capped: timeoutMs > capMs };
}

/** executeCommand result: CommandExecutionResult plus the process state and whether the wait ceiling ended the wait. */
export interface ProcessStartResult extends CommandExecutionResult {
  processState: ProcessState;  // State of the process when the wait ended (see getProcessState)
  waitCappedAtMs?: number;     // Set when the wait stopped at the wait ceiling before timeout_ms; the process keeps running
}

/**
 * Output buffering caps. Without a cap, a process emitting enough output makes
 * string concatenation throw "RangeError: Invalid string length" at V8's max
 * string size (~536M chars) inside a stdout 'data' handler — an uncaught
 * exception that kills the whole server (index.ts exits on uncaughtException).
 * The cap also bounds the cost of the reads that are O(total output), such as
 * since-start snapshot reads.
 */
export const MAX_BUFFERED_OUTPUT_CHARS = 50 * 1024 * 1024;  // per session; oldest lines evicted first
const MAX_LINE_CHARS = 1024 * 1024;                  // force-split longer lines so eviction can work
const MAX_WAIT_OUTPUT_CHARS = 2 * 1024 * 1024;       // start_process wait buffer (the initial output it returns)

// Result type for paginated output reading
export interface PaginatedOutputResult {
  lines: string[];
  totalLines: number;
  readFrom: number;            // Starting line of this read
  readCount: number;           // Number of lines returned
  remaining: number;           // Lines remaining after this read
  isComplete: boolean;         // Whether process has finished
  exitCode?: number | null;    // Exit code if completed
  runtimeMs?: number;          // Runtime in milliseconds (for completed processes)
  evictedLines?: number;       // Lines dropped by the buffer cap; when > 0, line numbers are relative to the retained buffer
}

export class TerminalManager {
  private sessions: Map<number, ManagedSession> = new Map();
  private completedSessions: Map<number, CompletedSession> = new Map();
  private deliveryTurn = 0;
  private deliveryTurnOpen = false;

  /**
   * Send input to a running process
   * @param pid Process ID
   * @param input Text to send to the process
   * @returns Whether input was successfully sent
   */
  sendInputToProcess(pid: number, input: string): boolean {
    const session = this.sessions.get(pid);
    if (!session) {
      return false;
    }
    
    try {
      if (session.process.stdin && !session.process.stdin.destroyed) {
        // Ensure input ends with a newline for most REPLs
        const inputWithNewline = input.endsWith('\n') ? input : input + '\n';
        session.process.stdin.write(inputWithNewline);
        return true;
      }
      return false;
    } catch (error) {
      console.error(`Error sending input to process ${pid}:`, error);
      return false;
    }
  }
  
  async executeCommand(command: string, timeoutMs: number = DEFAULT_COMMAND_TIMEOUT, shell?: string, collectTiming: boolean = false, maxWaitMs: number = MAX_PROCESS_WAIT_MS): Promise<ProcessStartResult> {
    let config: ServerConfig = {};
    try {
      config = await configManager.getConfig();
    } catch (error) {
      // If there's an error getting the config, fall back to the default shell
    }
    // Get the shell from config if not specified
    const shellToUse = shell || config.defaultShell || getDefaultShell();
    const waitLimit = getProcessWaitLimit(timeoutMs, maxWaitMs);

    // For REPL interactions, we need to ensure stdin, stdout, and stderr are properly configured
    // Note: No special stdio options needed here, Node.js handles pipes by default

    // Enhance SSH commands automatically
    let enhancedCommand = command;
    if (command.trim().startsWith('ssh ') && !command.includes(' -t')) {
      enhancedCommand = command.replace(/^ssh /, 'ssh -t ');
      console.log(`Enhanced SSH command: ${enhancedCommand}`);
    }

    // Get the appropriate spawn configuration for the shell, with login flags where appropriate
    const spawnConfig: ShellSpawnConfig = getShellSpawnArgs(shellToUse, enhancedCommand);
    const spawnOptions: any = {
      env: {
        ...process.env,
        TERM: 'xterm-256color'  // Better terminal compatibility
      },
      windowsHide: true  // Prevent visible console windows on Windows
    };

    // Add shell option if needed (for unknown shells)
    if (spawnConfig.useShellOption) {
      spawnOptions.shell = spawnConfig.useShellOption;
    }

    // Repair PATHEXT on Windows before spawning. On some Windows DXT launches
    // the server process inherits a corrupted PATHEXT (e.g. ".CPL"), which we
    // would otherwise propagate via { ...process.env } and break command
    // resolution (git, node, python, rg, ...) in the spawned shell. See #481.
    if (process.platform === 'win32' && spawnOptions.env) {
      spawnOptions.env.PATHEXT = getRepairedPathExt();
    }

    // On Windows, when we invoke cmd.exe directly and pass the user's command as a
    // single argument, Node/libuv applies MSVCRT-style quoting that escapes embedded
    // double quotes as \" . cmd.exe does not understand that escaping, so any command
    // containing quotes (e.g. a quoted path with spaces like "C:\Program Files\app.exe")
    // is corrupted before the shell ever parses it. Passing arguments verbatim lets
    // cmd handle its own quoting. Scoped to shells that set windowsVerbatim (cmd only)
    // because PowerShell/pwsh have different quote rules and must NOT use verbatim.
    if (process.platform === 'win32' && spawnConfig.windowsVerbatim) {
      spawnOptions.windowsVerbatimArguments = true;
    }

    // Spawn the process with appropriate arguments
    const childProcess = spawn(spawnConfig.executable, spawnConfig.args, spawnOptions);
    let output = '';

    // spawn() reports failure asynchronously via an 'error' event; it does not
    // throw. Node rethrows an 'error' that has no listener as an uncaught
    // exception, and our process-level handler (src/index.ts) turns that into
    // process.exit(1). So an unresolvable executable — e.g. shell: "/usr/bin/bash"
    // on Windows — used to kill the entire MCP server one tick AFTER this
    // function had already returned "Failed to get process ID", making the crash
    // look unrelated to the command that caused it. Under `remote` the parent
    // then kept accepting tool calls over a dead stdio pipe ("Not connected").
    //
    // Attach before any return path below, and keep it for the session lifetime
    // so a later runtime error (EPIPE on a closed stdin, ...) can't crash us either.
    let forwardProcessError: ((err: Error) => void) | null = null;
    let pendingProcessError: Error | null = null;
    childProcess.on('error', (err: Error) => {
      if (forwardProcessError) {
        forwardProcessError(err);
      } else {
        pendingProcessError = err;
        console.error(`Process error for "${command}": ${err.message}`);
      }
    });

    // Ensure childProcess.pid is defined before proceeding
    if (!childProcess.pid) {
      // Return a consistent error object instead of throwing
      const output = 'Error: Failed to get process ID. The command could not be executed.';
      return {
        pid: -1,  // Use -1 to indicate an error state
        output,
        isBlocked: false,
        processState: analyzeProcessState(output)
      };
    }

    const session: ManagedSession = {
      pid: childProcess.pid,
      process: childProcess,
      outputLines: [],           // Line-based buffer
      lastReadIndex: 0,          // Track where "new" output starts
      lastReadOpenLine: '',
      isBlocked: false,
      startTime: new Date(),
      bufferedChars: 0,
      evictedLines: 0,
      evictedChars: 0,
      streams: newStreamTails()
    };

    this.sessions.set(childProcess.pid, session);

    // Timing telemetry
    const startTime = Date.now();
    let firstOutputTime: number | undefined;
    let lastOutputTime: number | undefined;
    const outputEvents: OutputEvent[] = [];
    let exitReason: TimingInfo['exitReason'] = 'timeout';

    return new Promise((resolve) => {
      let resolved = false;
      let periodicCheck: NodeJS.Timeout | null = null;

      // Quick prompt patterns for immediate detection
      const quickPromptPatterns = />>>\s*$|>\s*$|\$\s*$|#\s*$/;

      const resolveOnce = (waitResult: Omit<ProcessStartResult, 'processState'>) => {
        if (resolved) return;
        resolved = true;
        if (periodicCheck) clearInterval(periodicCheck);

        // The state the wait ended in, from the session's output. A process
        // error leaves no session behind, so the text it returns is judged.
        const result: ProcessStartResult = {
          ...waitResult,
          processState: this.getProcessState(childProcess.pid!) ?? analyzeProcessState(waitResult.output)
        };

        // Add timing info if requested
        if (collectTiming) {
          const endTime = Date.now();
          result.timingInfo = {
            startTime,
            endTime,
            totalDurationMs: endTime - startTime,
            exitReason,
            firstOutputTime,
            lastOutputTime,
            timeToFirstOutputMs: firstOutputTime ? firstOutputTime - startTime : undefined,
            outputEvents: outputEvents.length > 0 ? outputEvents : undefined
          };
        }

        resolve(result);
      };

      // Now that resolveOnce exists, route process errors into it: an error after
      // a successful spawn means the process is gone, so the caller must not sit
      // waiting for output that will never arrive.
      forwardProcessError = (err: Error) => {
        this.sessions.delete(childProcess.pid!);
        exitReason = 'process_exit';
        resolveOnce({
          pid: childProcess.pid!,
          output: output + `\nProcess error: ${err.message}`,
          isBlocked: false
        });
      };
      // An error emitted between spawn and here (the common case — spawn errors
      // land on the next tick) is replayed rather than dropped.
      if (pendingProcessError) {
        forwardProcessError(pendingProcessError);
      }

      childProcess.stdout.on('data', (data: any) => {
        const text = data.toString();
        const now = Date.now();

        if (!firstOutputTime) firstOutputTime = now;
        lastOutputTime = now;

        // `output` only feeds the wait-phase result, so stop growing it once
        // resolved and keep only a bounded tail.
        if (!resolved) {
          output += text;
          if (output.length > MAX_WAIT_OUTPUT_CHARS) {
            output = output.slice(-Math.floor(MAX_WAIT_OUTPUT_CHARS / 2));
          }
        }
        this.recordOutput(session, 'stdout', text);

        // Record output event if collecting timing
        if (collectTiming) {
          outputEvents.push({
            timestamp: now,
            deltaMs: now - startTime,
            source: 'stdout',
            length: text.length,
            snippet: text.slice(0, 50).replace(/\n/g, '\\n')
          });
        }

        // Immediate check for obvious prompts
        if (quickPromptPatterns.test(text)) {
          session.isBlocked = true;
          exitReason = 'early_exit_quick_pattern';

          if (collectTiming && outputEvents.length > 0) {
            outputEvents[outputEvents.length - 1].matchedPattern = 'quick_pattern';
          }

          resolveOnce({
            pid: childProcess.pid!,
            output,
            isBlocked: true
          });
        }
      });

      childProcess.stderr.on('data', (data: any) => {
        const text = data.toString();
        const now = Date.now();

        if (!firstOutputTime) firstOutputTime = now;
        lastOutputTime = now;

        if (!resolved) {
          output += text;
          if (output.length > MAX_WAIT_OUTPUT_CHARS) {
            output = output.slice(-Math.floor(MAX_WAIT_OUTPUT_CHARS / 2));
          }
        }
        this.recordOutput(session, 'stderr', text);

        // Record output event if collecting timing
        if (collectTiming) {
          outputEvents.push({
            timestamp: now,
            deltaMs: now - startTime,
            source: 'stderr',
            length: text.length,
            snippet: text.slice(0, 50).replace(/\n/g, '\\n')
          });
        }
      });

      // Periodic comprehensive check every 100ms
      periodicCheck = setInterval(() => {
        if (this.getProcessState(childProcess.pid!)?.isWaitingForInput) {
          session.isBlocked = true;
          exitReason = 'early_exit_periodic_check';
          resolveOnce({
            pid: childProcess.pid!,
            output,
            isBlocked: true
          });
        }
      }, 100);

      // Timeout fallback, bounded by the wait ceiling so the call returns
      // before the MCP client gives up on it; the process keeps running.
      setTimeout(() => {
        session.isBlocked = true;
        exitReason = 'timeout';
        resolveOnce({
          pid: childProcess.pid!,
          output,
          isBlocked: true,
          ...(waitLimit.capped && { waitCappedAtMs: waitLimit.capMs })
        });
      }, waitLimit.waitMs);

      childProcess.on('exit', (code: any) => {
        if (childProcess.pid) {
          // Store completed session before removing active session
          this.completedSessions.set(childProcess.pid, {
            session,
            exitCode: code,
            endTime: new Date()
          });

          // Keep only last 100 completed sessions
          if (this.completedSessions.size > 100) {
            const oldestKey = Array.from(this.completedSessions.keys())[0];
            this.completedSessions.delete(oldestKey);
          }

          this.sessions.delete(childProcess.pid);
        }
        exitReason = 'process_exit';
        resolveOnce({
          pid: childProcess.pid!,
          output,
          isBlocked: false
        });
      });
    });
  }

  /**
   * Add a chunk of one stream's output to the session: to the merged line
   * buffer, and to that stream's tail for state detection.
   */
  private recordOutput(session: ManagedSession, stream: OutputStream, text: string): void {
    this.appendToLineBuffer(session, text);
    const tail = session.streams[stream];
    tail.text = (text.length >= STATE_DETECTION_TAIL_CHARS ? text : tail.text + text).slice(-STATE_DETECTION_TAIL_CHARS);
    tail.chars += text.length;
    tail.turn = this.currentDeliveryTurn();
  }

  /**
   * Number of the event-loop turn now delivering output; every chunk
   * dispatched before the next check phase (setImmediate) shares it.
   *
   * stdout and stderr are separate pipes. Each turn delivers what the OS had
   * ready when the loop polled, so a chunk delivered in a later turn was
   * written after the chunks of earlier turns. Within one turn the pipes come
   * in either order: when python -i's final stdout newline and its stderr
   * ">>> " prompt are both waiting, the prompt is often delivered first.
   */
  private currentDeliveryTurn(): number {
    if (!this.deliveryTurnOpen) {
      this.deliveryTurnOpen = true;
      this.deliveryTurn++;
      setImmediate(() => { this.deliveryTurnOpen = false; });
    }
    return this.deliveryTurn;
  }

  /**
   * Append text to a session's line buffer
   * Handles partial lines and newline splitting
   */
  private appendToLineBuffer(session: TerminalSession, text: string): void {
    if (!text) return;

    // Split text into lines, keeping track of whether text ends with newline
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isLastFragment = i === lines.length - 1;
      const endsWithNewline = text.endsWith('\n');

      if (session.outputLines.length === 0) {
        // First line ever
        session.outputLines.push(line);
      } else if (i === 0) {
        // First fragment - append to last line (might be partial)
        session.outputLines[session.outputLines.length - 1] += line;
      } else {
        // Subsequent lines - add as new lines
        session.outputLines.push(line);
      }
    }
    // Appended text contributes exactly its length to the joined buffer
    // (its newlines become the join separators).
    session.bufferedChars += text.length;

    // A process printing without newlines grows a single line forever, which
    // eviction can't bound — force-split so no line exceeds MAX_LINE_CHARS.
    // Each inserted break adds one separator to the joined length.
    let lastIndex = session.outputLines.length - 1;
    while (session.outputLines[lastIndex].length > MAX_LINE_CHARS) {
      const overlong = session.outputLines[lastIndex];
      session.outputLines[lastIndex] = overlong.slice(0, MAX_LINE_CHARS);
      session.outputLines.push(overlong.slice(MAX_LINE_CHARS));
      session.bufferedChars += 1;
      lastIndex++;
    }

    // Enforce the per-session cap by evicting the oldest lines. Keeps the
    // buffer far below V8's max string length so concatenation and join()
    // can never throw "Invalid string length" and kill the server.
    // Count them first and drop them with one splice: on an array this large
    // every shift() copies the whole array, and a line-by-line shift() stalled
    // the event loop for seconds per chunk once a session reached the cap.
    let evicted = 0;
    while (session.bufferedChars > MAX_BUFFERED_OUTPUT_CHARS && evicted < session.outputLines.length - 1) {
      const droppedJoinedChars = session.outputLines[evicted].length + 1; // +1 for its join separator
      session.bufferedChars -= droppedJoinedChars;
      session.evictedChars += droppedJoinedChars;
      evicted++;
    }
    if (evicted > 0) {
      session.outputLines.splice(0, evicted);
      session.evictedLines += evicted;
      session.lastReadIndex = Math.max(0, session.lastReadIndex - evicted);
    }
  }

  /**
   * Read process output with pagination (like file reading)
   * @param pid Process ID
   * @param offset Line offset: 0=from lastReadIndex, positive=absolute, negative=tail
   * @param length Max lines to return
   * @param updateReadIndex Whether to update lastReadIndex (default: true for offset=0)
   */
  readOutputPaginated(pid: number, offset: number = 0, length: number = 1000): PaginatedOutputResult | null {
    // First check active sessions
    const session = this.sessions.get(pid);
    if (session) {
      const result = this.readFromLineBuffer(session, offset, length, false, undefined);
      result.evictedLines = session.evictedLines;
      return result;
    }

    // Then check completed sessions: they keep their read position, so
    // reading on after the exit continues where the last read stopped
    const completedSession = this.completedSessions.get(pid);
    if (completedSession) {
      const runtimeMs = completedSession.endTime.getTime() - completedSession.session.startTime.getTime();
      const result = this.readFromLineBuffer(
        completedSession.session,
        offset,
        length,
        true,
        completedSession.exitCode,
        runtimeMs
      );
      result.evictedLines = completedSession.session.evictedLines;
      return result;
    }

    return null;
  }

  /**
   * Whether a default read (offset 0) has anything to return: complete lines
   * past the read position, or an unfinished last line with text a read
   * hasn't returned (see readFromLineBuffer). Line counts alone can't tell
   * the second: text appended to that line adds no line.
   */
  hasUnreadOutput(pid: number): boolean {
    const session = this.sessions.get(pid) ?? this.completedSessions.get(pid)?.session;
    if (!session) {
      return false;
    }
    return session.outputLines.length - 1 > session.lastReadIndex || TerminalManager.openLineHasNewText(session);
  }

  /**
   * Whether the unfinished last line has text that a default read hasn't
   * returned. Empty, it has nothing to return. Its text is compared with what
   * a read last returned only while it is the line that read stopped at: a
   * later line is new even when its text is the same (a REPL's next ">>> ").
   */
  private static openLineHasNewText(session: TerminalSession): boolean {
    const lines = session.outputLines;
    const openLine = lines[lines.length - 1] ?? '';
    return openLine !== '' && (lines.length - 1 !== session.lastReadIndex || openLine !== session.lastReadOpenLine);
  }

  /**
   * Internal helper to read from a session's line buffer with offset/length
   */
  private readFromLineBuffer(
    session: TerminalSession,
    offset: number,
    length: number,
    isComplete: boolean,
    exitCode?: number | null,
    runtimeMs?: number
  ): PaginatedOutputResult {
    const lines = session.outputLines;
    // The empty last line after a trailing newline holds nothing: it isn't
    // counted (total, remaining, tail offsets) or returned. A last line with
    // text, unfinished or not, is.
    const totalLines = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
    let startIndex: number;
    let linesToRead: string[];
    let readableEnd = totalLines;

    if (offset < 0) {
      // Negative offset = start position from end, then read 'length' lines forward
      // e.g., offset=-50, length=10 means: start 50 lines from end, read 10 lines
      const fromEnd = Math.abs(offset);
      startIndex = Math.max(0, totalLines - fromEnd);
      linesToRead = lines.slice(startIndex, Math.min(startIndex + length, totalLines));
      // Don't update lastReadIndex for tail reads
    } else if (offset === 0) {
      // offset=0 means "from where I last read" (like getNewOutput).
      // The last line is unfinished: output is appended to it until a newline
      // arrives, even after the exit (a process the command started can still
      // write). So it is returned only when it has text a read hasn't
      // returned, and the read position never moves past it: counting it as
      // read would lose whatever is appended to it next.
      const openLineIndex = Math.max(lines.length - 1, 0);
      readableEnd = TerminalManager.openLineHasNewText(session) ? lines.length : openLineIndex;
      startIndex = session.lastReadIndex;
      linesToRead = lines.slice(startIndex, Math.min(startIndex + length, readableEnd));
      const readTo = startIndex + linesToRead.length;
      if (readTo === lines.length) {
        session.lastReadOpenLine = lines[lines.length - 1];
      }
      session.lastReadIndex = Math.min(readTo, openLineIndex);
    } else {
      // Positive offset = absolute position
      startIndex = offset;
      linesToRead = lines.slice(startIndex, Math.min(startIndex + length, totalLines));
      // Don't update lastReadIndex for absolute position reads
    }

    const readCount = linesToRead.length;
    const endIndex = startIndex + readCount;
    const remaining = Math.max(0, readableEnd - endIndex);

    return {
      lines: linesToRead,
      totalLines,
      readFrom: startIndex,
      readCount,
      remaining,
      isComplete,
      exitCode,
      runtimeMs
    };
  }

  /**
   * Get total line count for a process
   */
  getOutputLineCount(pid: number): number | null {
    const session = this.sessions.get(pid);
    if (session) {
      return session.outputLines.length;
    }

    const completedSession = this.completedSessions.get(pid);
    if (completedSession) {
      return completedSession.session.outputLines.length;
    }

    return null;
  }

  /**
   * Legacy method for backward compatibility
   * Returns all new output since last read
   * @param maxLines Maximum lines to return (default: 1000 for context protection)
   * @deprecated Use readOutputPaginated instead
   */
  getNewOutput(pid: number, maxLines: number = 1000): string | null {
    const result = this.readOutputPaginated(pid, 0, maxLines);
    if (!result) return null;

    const output = result.lines.join('\n').trim();

    // For completed sessions, append completion info with runtime
    if (result.isComplete) {
      const runtimeStr = result.runtimeMs !== undefined 
        ? `\nRuntime: ${(result.runtimeMs / 1000).toFixed(2)}s` 
        : '';
      if (output) {
        return `${output}\n\nProcess completed with exit code ${result.exitCode}${runtimeStr}`;
      } else {
        return `Process completed with exit code ${result.exitCode}${runtimeStr}\n(No output produced)`;
      }
    }

    // Add truncation warning if there's more output
    if (result.remaining > 0) {
      return `${output}\n\n[Output truncated: ${result.remaining} more lines available. Use read_process_output with offset/length for full output.]`;
    }

    return output || null;
  }

  /**
   * Capture a snapshot of current output state for interaction tracking.
   * Used by interactWithProcess to know what output existed before sending input.
   */
  captureOutputSnapshot(pid: number): OutputSnapshot | null {
    const session = this.sessions.get(pid);
    return session ? TerminalManager.endOfOutput(session) : null;
  }

  /**
   * Get output that appeared since a snapshot was taken.
   * This handles the case where output is appended to the last line (REPL prompts).
   * Also checks completed sessions in case process finished between snapshot and poll.
   */
  getOutputSinceSnapshot(pid: number, snapshot: OutputSnapshot): string | null {
    return this.readOutputSince(pid, snapshot)?.output ?? null;
  }

  /**
   * Output that appeared since `snapshot`, plus the snapshot at the current end
   * of output. A poller passes `next` back in to read only the output that
   * arrived since its previous poll. Costs O(output since snapshot), never
   * O(whole buffer), so polling stays cheap however much history the session
   * has retained. Also checks completed sessions in case the process finished
   * between snapshot and poll.
   */
  readOutputSince(pid: number, snapshot: OutputSnapshot): { output: string; next: OutputSnapshot } | null {
    const buffer: OutputBuffer | undefined = this.sessions.get(pid) ?? this.completedSessions.get(pid)?.session;
    if (!buffer) {
      return null;
    }
    return {
      output: TerminalManager.outputSinceSnapshot(buffer, snapshot.totalChars),
      next: TerminalManager.endOfOutput(buffer)
    };
  }

  /**
   * Snapshot at the current end of a buffer, in O(1): bufferedChars is the
   * joined length of the retained lines, so nothing is joined here.
   */
  private static endOfOutput(buffer: OutputBuffer): OutputSnapshot {
    return {
      // Absolute since process start (includes evicted output), so the
      // offset stays valid even if the cap evicts lines between
      // snapshot and read.
      totalChars: buffer.evictedChars + buffer.bufferedChars,
      lineCount: buffer.evictedLines + buffer.outputLines.length,
      streamChars: { stdout: buffer.streams.stdout.chars, stderr: buffer.streams.stderr.chars }
    };
  }

  /**
   * The process's state (waiting for input, finished or running), judged from
   * the end of the output it wrote since `since` (default: since it started).
   * Reads only the per-stream tails, so it costs the same however much output
   * the process has produced. Also checks completed sessions. The one place
   * start_process, interact_with_process and read_process_output get the
   * state from.
   */
  getProcessState(pid: number, since?: OutputSnapshot): ProcessState | null {
    const buffer: OutputBuffer | undefined = this.sessions.get(pid) ?? this.completedSessions.get(pid)?.session;
    if (!buffer) {
      return null;
    }
    return analyzeProcessState(TerminalManager.lastWrittenOutput(buffer.streams, since), pid);
  }

  /**
   * The output since `since` of each stream that may have written last: the
   * streams delivered in the latest turn that delivered anything since then.
   * Their relative order within that turn is unknown (see
   * currentDeliveryTurn), so each is judged on its own; streams last
   * delivered in an earlier turn wrote before them and can't end the output.
   */
  private static lastWrittenOutput(streams: StreamTails, since?: OutputSnapshot): string[] {
    const recent = OUTPUT_STREAMS
      .map(name => {
        const { text, chars, turn } = streams[name];
        const newChars = chars - (since?.streamChars[name] ?? 0);
        return { text: newChars > 0 ? text.slice(-newChars) : '', turn };
      })
      .filter(stream => stream.text.length > 0);
    const lastTurn = Math.max(...recent.map(stream => stream.turn));
    return recent.filter(stream => stream.turn === lastTurn).map(stream => stream.text);
  }

  /**
   * New output since a snapshot, in absolute (since process start) offsets:
   * the last (end - snapshot) chars of the joined buffer. Walks back from the
   * newest line only until the snapshot position is covered and joins just
   * those lines. If eviction dropped part of the unseen output, returns what
   * the buffer still holds — the oldest unseen chars are lost to the cap.
   */
  private static outputSinceSnapshot(buffer: OutputBuffer, snapshotTotalChars: number): string {
    const { outputLines } = buffer;
    const newChars = buffer.evictedChars + buffer.bufferedChars - snapshotTotalChars;
    if (newChars <= 0 || outputLines.length === 0) {
      return ''; // No new output
    }
    let firstLine = outputLines.length - 1;
    let tailChars = outputLines[firstLine].length; // Joined length of outputLines[firstLine..]
    while (tailChars < newChars && firstLine > 0) {
      firstLine--;
      tailChars += outputLines[firstLine].length + 1; // +1 for its join separator
    }
    const tail = outputLines.slice(firstLine).join('\n');
    return tail.substring(Math.max(0, tail.length - newChars));
  }

    /**
   * Get a session by PID
   * @param pid Process ID
   * @returns The session or undefined if not found
   */
  getSession(pid: number): TerminalSession | undefined {
    return this.sessions.get(pid);
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
        // Convert error to string, handling both Error objects and other types
        const errorMessage = error instanceof Error ? error.message : String(error);
        capture('server_request_error', {error: errorMessage, message: `Failed to terminate process ${pid}:`});
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