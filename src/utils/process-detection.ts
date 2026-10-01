/**
 * REPL and Process State Detection Utilities
 * Detects from its output whether a running process is waiting for input.
 * Whether it has finished is known from its exit, never from its output
 * (see TerminalManager.getProcessState).
 */

export interface ProcessState {
  isWaitingForInput: boolean;
  isFinished: boolean;
  isRunning: boolean;
  detectedPrompt?: string;
  lastOutput: string;
}

// Common REPL prompts. Most are generic ("... ", "> ", "+ ", "| "): inside or
// at the end of a longer line they are ordinary text (pytest -v's "collecting
// ... ", #196; a markdown table's "| a | b |"), so they count only in a last
// line made of prompts alone: the prompt itself, the prompts a REPL that
// doesn't echo input printed one after another ("> | " from node -i), or,
// from a REPL that writes its prompts to stderr (python -i, bash -i), the
// prompts it wrote there (">>> ... ").
const REPL_PROMPTS = {
  python: ['>>> ', '... '],
  node: ['> ', '... ', '| '], // "| ": Node 24's continuation, "... " before it
  r: ['> ', '+ '],
  julia: ['julia> ', '       '], // julia continuation is spaces
  shell: ['$ ', '# ', '% '],
  mysql: ['mysql> ', '    -> '],
  postgres: ['=# ', '-# '],
  redis: ['redis> '],
  mongo: ['> ', '... '],
  powershell: ['>> '] // continuation; after "> ", so it is reported as "> ", as before
};

const PROMPTS = [...new Set(Object.values(REPL_PROMPTS).flat())];
const PROMPTS_ONLY = new RegExp(`^(?:${PROMPTS.map(escapeRegExp).join('|')})+$`);

// Prompts that also count at the end of a longer line: named ones, after
// output that didn't end in a newline ("done>>> "), and a shell or psql
// prompt's end ("bash-5.2$ ", "user@host dir % ", "postgres=# ")
const LINE_END_PROMPTS = ['>>> ', 'julia> ', 'mysql> ', 'redis> ', '$ ', '# ', '% '];

// PowerShell's prompt (powershell.exe, pwsh), at the end of a line: "PS ", a
// location (a drive, provider or path: "C:\Users\me", "/Users/me", "HKLM:\"),
// then "> " (">> " in a nested or debugger prompt, "[DBG]: PS C:\>> ")
const POWERSHELL_PROMPT_TEXT = String.raw`PS [^<>|\n]*[\\/:][^<>|\n]*>>? `;
const POWERSHELL_PROMPT = new RegExp(`${POWERSHELL_PROMPT_TEXT}$`);

// cmd.exe's prompt: the whole last line is a path and ">", with nothing after
// it ("C:\Users\me>"); output lines end in a newline, a prompt doesn't
const CMD_PROMPT_TEXT = String.raw`[A-Za-z]:\\[^<>|"*?\n]*>`;
const CMD_PROMPT = new RegExp(`^${CMD_PROMPT_TEXT}$`);

// The same shell prompts at the start of a line, where the shell echoes the
// next input line after them ("PS C:\Users\me> echo b", "C:\Users\me>echo b")
const SHELL_PROMPTS_AT_START = [new RegExp(`^${POWERSHELL_PROMPT_TEXT}`), new RegExp(`^${CMD_PROMPT_TEXT}`)];

// The REPL prompts output cleaning removes, one or more in a row at the start
// of a line (">>> ... " from a REPL that reads several lines at once)
const REPL_PROMPT = String.raw`(?:>>> |\.\.\. |>> |> |\| |\+ )`;
const REPL_PROMPT_RUN = new RegExp(`^${REPL_PROMPT}+`);
const REPL_PROMPTS_ALONE = new RegExp(`^${REPL_PROMPT}+$`);
const REPL_PROMPT_TOKEN = new RegExp(REPL_PROMPT, 'g');
// The prompts of a REPL waiting for more of a statement (Python, Node, PowerShell, R)
const CONTINUATION_PROMPTS = ['... ', '| ', '>> ', '+ '];

/** The prompt the last line of output is, or ends in, if any */
function findPrompt(lastLine: string): string | undefined {
  if (PROMPTS_ONLY.test(lastLine)) {
    return PROMPTS.find(prompt => lastLine.endsWith(prompt));
  }
  const lineEnd = LINE_END_PROMPTS.find(prompt => lastLine.endsWith(prompt));
  if (lineEnd) return lineEnd;
  // Reported as "> ", which a PowerShell prompt was reported as before #196
  if (POWERSHELL_PROMPT.test(lastLine) || CMD_PROMPT.test(lastLine)) return '> ';
  return undefined;
}

/**
 * How much of the end of the output state detection examines. A prompt is
 * the last thing a process writes before it waits for input, so the end of
 * the output decides the state; examining only this much keeps detection's
 * cost the same however much output there is.
 */
export const STATE_DETECTION_TAIL_CHARS = 4096;

/**
 * Analyze a running process's output to determine whether it is waiting for
 * input. Output text never makes a process finished: a line such as
 * "Error: retrying" doesn't end it.
 *
 * `output` is what the process wrote most recently. For a process writing to
 * both stdout and stderr it can be the recent output of each stream that may
 * have written last (see TerminalManager.getProcessState): their relative
 * order is unknown, so the process is waiting for input if any of them ends
 * in a prompt. Only the last STATE_DETECTION_TAIL_CHARS of each are examined.
 */
export function analyzeProcessState(output: string | readonly string[], pid?: number): ProcessState {
  const tails = (typeof output === 'string' ? [output] : output)
    .map(text => text.slice(-STATE_DETECTION_TAIL_CHARS))
    .filter(text => text.trim().length > 0);
  const states = tails.map(analyzeOutputTail);
  return states.find(state => state.isWaitingForInput)
    ?? {
      isWaitingForInput: false,
      isFinished: false,
      isRunning: true,
      lastOutput: tails.join('\n')
    };
}

/**
 * The state the end of one stream's output shows (see analyzeProcessState).
 */
function analyzeOutputTail(output: string): ProcessState {
  const lines = output.split('\n');
  const lastLine = lines[lines.length - 1] || '';

  // Check for REPL prompts (waiting for input)
  const detectedPrompt = findPrompt(lastLine);

  if (detectedPrompt) {
    return {
      isWaitingForInput: true,
      isFinished: false,
      isRunning: true,
      detectedPrompt,
      lastOutput: output
    };
  }

  // Default: process is running, not waiting for input
  return {
    isWaitingForInput: false,
    isFinished: false,
    isRunning: true,
    lastOutput: output
  };
}

/**
 * Clean output by removing prompts and input echoes. `readAtPrompt`: whether
 * the process was waiting at a prompt when the input was sent; one that
 * wasn't (a shell reading commands without a prompt) prints none for it.
 */
export function cleanProcessOutput(output: string, inputSent?: string, readAtPrompt: boolean = true): string {
  // A process at a prompt prints one prompt for each input line it reads
  const printed = readAtPrompt && inputSent !== undefined ? inputLinesSent(inputSent).length : 0;
  const withoutEcho = removeInputEcho(output, inputSent);
  const cleaned = removePrompts(withoutEcho.output, printed - withoutEcho.prompts);
  // A line repeating the input is the answer, not an echo, when nothing else
  // came back: node -i answers `10` with "10", which was removed as the echo.
  // Not at a continuation prompt: the process waits for more of the input,
  // so it hasn't answered it
  if (!cleaned && withoutEcho.output !== output && !waitsAtContinuationPrompt(output)) {
    return removePrompts(output, printed);
  }
  return cleaned;
}

/** Whether the output ends at a continuation prompt (">> " after "if ($true) {") */
function waitsAtContinuationPrompt(output: string): boolean {
  const lastLine = output.slice(output.lastIndexOf('\n') + 1);
  if (!REPL_PROMPTS_ALONE.test(lastLine)) return false;
  const prompts = lastLine.match(REPL_PROMPT_TOKEN) ?? [];
  return CONTINUATION_PROMPTS.includes(prompts[prompts.length - 1]);
}

/**
 * The output without the process's echo of the input, if it echoed it. A
 * process that echoes (powershell.exe, cmd.exe, a terminal over ssh -t)
 * repeats each input line where the output for it starts: the first line at
 * the start of the output, each later one after the prompt it was read at
 * ("PS C:\project> echo b", "C:\project>echo b", ">> }"). A line the process
 * has read (it printed a prompt for it) that isn't repeated there means the
 * process doesn't echo, and a line equal to an input line is output (node -i
 * answers `1` with "1"): the output is kept as it is. Lines not read yet (the
 * call answered at an earlier prompt) have no echo yet. Also returns how many
 * prompts went with the echoes.
 */
function removeInputEcho(output: string, inputSent?: string): { output: string; prompts: number } {
  if (!inputSent) return { output, prompts: 0 };
  const lines = output.split('\n');
  const echoes = new Set<number>();
  let next = 0;
  for (const [i, inputLine] of inputLinesSent(inputSent).entries()) {
    const echo = inputLine.trim();
    if (!echo) continue; // An empty line's echo can't be told from an empty output line
    const at = i === 0
      ? (isEchoLine(lines, 0, echo, true) ? 0 : -1)
      : lines.findIndex((_, index) => index >= next && isEchoLine(lines, index, echo, false));
    if (at < 0) {
      // A process prints one prompt for each line it reads
      const linesRead = lines.reduce((count, line) => count + promptsAtStart(line), 0);
      if (linesRead > i) return { output, prompts: 0 };
      break;
    }
    echoes.add(at);
    next = at + 1;
  }
  return {
    output: lines.filter((_, index) => !echoes.has(index)).join('\n'),
    prompts: [...echoes].reduce((count, index) => count + promptsAtStart(lines[index]), 0),
  };
}

/** How many prompts `line` starts with: REPL prompts, one or more in a row, or a shell's prompt */
function promptsAtStart(line: string): number {
  const run = REPL_PROMPT_RUN.exec(line)?.[0];
  if (run) return run.match(REPL_PROMPT_TOKEN)?.length ?? 0;
  return SHELL_PROMPTS_AT_START.some(prompt => prompt.test(line)) ? 1 : 0;
}

/** The lines of an input as the process reads them (sendInputToProcess ends it with a newline) */
function inputLinesSent(input: string): string[] {
  return (input.endsWith('\n') ? input.slice(0, -1) : input).split('\n');
}

/**
 * Whether lines[index] is the echo of an input line: alone on the line (the
 * first input line's, at the start of the output) or after a prompt (a later
 * line's), and ended by the newline that was sent with it
 */
function isEchoLine(lines: string[], index: number, echo: string, alone: boolean): boolean {
  if (index >= lines.length - 1) return false;
  const line = lines[index].trimEnd();
  if (!line.endsWith(echo)) return false;
  const before = line.slice(0, line.length - echo.length).trimEnd();
  if (alone) return before === '';
  return before !== '' && (findPrompt(before) !== undefined || findPrompt(`${before} `) !== undefined);
}

/**
 * The output without the REPL prompts the process printed for the input (at
 * most `printed`), and nothing that only looks like one. The last line, when
 * it is a prompt, is where the process waits now (a REPL's is removed; a
 * shell's, "PS C:\project> ", stays in the output as before). The others
 * start a line: the one where the output for the next input line begins
 * ("1\n> 2\n> " for `1` and `2` sent to node -i). More prompt-like line starts
 * than that means some are output ("+ added" in a diff, "> quoted"), and
 * those lines are all kept as they are.
 */
function removePrompts(output: string, printed: number): string {
  const lines = output.split('\n');
  const last = lines.length - 1;
  let left = printed;
  if (findPrompt(lines[last]) !== undefined) {
    left -= Math.max(1, promptsAtStart(lines[last]));
    if (REPL_PROMPTS_ALONE.test(lines[last])) lines[last] = '';
  }
  const runs = lines.map((line, index) => (index < last ? REPL_PROMPT_RUN.exec(line)?.[0] ?? '' : ''));
  const found = runs.reduce((count, run) => count + (run.match(REPL_PROMPT_TOKEN)?.length ?? 0), 0);
  if (found <= left) {
    runs.forEach((run, index) => { lines[index] = lines[index].slice(run.length); });
  }
  return lines.join('\n').trim();
}

/**
 * Escape special regex characters
 */
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Format process state for user display
 */
export function formatProcessStateMessage(state: ProcessState, pid: number): string {
  if (state.isWaitingForInput) {
    return `Process ${pid} is waiting for input${state.detectedPrompt ? ` (detected: "${state.detectedPrompt.trim()}")` : ''}`;
  } else if (state.isFinished) {
    return `Process ${pid} has finished execution`;
  } else {
    return `Process ${pid} is running`;
  }
}
