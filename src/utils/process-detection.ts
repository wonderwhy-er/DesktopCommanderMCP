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

// Common REPL prompts. Most are generic ("... ", "> ", "+ "): inside or at the
// end of a longer line they are ordinary text (pytest -v's "collecting ... ",
// #196), so they count only in a last line made of prompts alone: the prompt
// itself, or, from a REPL that writes its prompts to stderr and doesn't echo
// input (python -i, bash -i), the prompts it wrote one after another there
// (">>> ... ").
const REPL_PROMPTS = {
  python: ['>>> ', '... '],
  node: ['> ', '... '],
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
const POWERSHELL_PROMPT = /PS [^<>|\n]*[\\/:][^<>|\n]*>>? $/;

// cmd.exe's prompt: the whole last line is a path and ">", with nothing after
// it ("C:\Users\me>"); output lines end in a newline, a prompt doesn't
const CMD_PROMPT = /^[A-Za-z]:\\[^<>|"*?\n]*>$/;

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
 * Clean output by removing prompts and input echoes
 */
export function cleanProcessOutput(output: string, inputSent?: string): string {
  let cleaned = output;

  // Remove input echo if provided
  if (inputSent) {
    const inputLines = inputSent.split('\n');
    inputLines.forEach(line => {
      if (line.trim()) {
        cleaned = cleaned.replace(new RegExp(`^${escapeRegExp(line.trim())}\\s*\n?`, 'm'), '');
      }
    });
  }

  // Remove common prompt patterns from output
  cleaned = cleaned.replace(/^>>>\s*/gm, '');  // Python >>>
  cleaned = cleaned.replace(/^>\s*/gm, '');    // Node.js/Shell >
  cleaned = cleaned.replace(/^\.{3}\s*/gm, ''); // Python ...
  cleaned = cleaned.replace(/^\+\s*/gm, '');   // R +

  // Remove trailing prompts
  cleaned = cleaned.replace(/\n>>>\s*$/, '');
  cleaned = cleaned.replace(/\n>\s*$/, '');
  cleaned = cleaned.replace(/\n\+\s*$/, '');

  return cleaned.trim();
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
