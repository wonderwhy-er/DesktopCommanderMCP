import { spawn, type ChildProcess } from 'child_process';
import { getCommandEnvironment, resolveProgramPath } from './shell.js';
import type { CommandReading, DefinedFunction, FoundCommand } from './command-reading.js';

/**
 * The command check's reader for PowerShell. No JavaScript parser reads
 * PowerShell correctly (here-strings, @{ } tables, & $var), so a helper
 * PowerShell process reads each command with PowerShell's own parser. It
 * starts at the first PowerShell check, so nothing runs for users who never
 * run PowerShell commands, and it is kept running: a check then takes a few
 * milliseconds instead of PowerShell's start (about a second for Windows
 * PowerShell). It is not a terminal session, so list_sessions never shows it.
 */

/** How long a check waits for a running helper's answer. A helper that doesn't answer is stopped, and the check fails. */
export const HELPER_TIMEOUT_MS = 5000;

/**
 * How long the first check waits after a helper starts, PowerShell's start
 * included: about a second for Windows PowerShell, longer on a busy machine
 */
export const HELPER_START_TIMEOUT_MS = 15000;

/**
 * The helper, run with -EncodedCommand. It reads one JSON request per line
 * ({ id, command }) and writes one JSON answer per line. It only parses the
 * command and looks names up with Get-Command; it never runs the command.
 * Module autoloading is off so that looking up a name never imports a module.
 * - commands: every CommandAst, also inside script blocks and functions. Its
 *   name is what it means in this PowerShell: an alias gives its target, a
 *   program or script found on PATH its file name without the extension
 *   (net.exe gives net). A name Get-Command doesn't know stays as written.
 *   A name from a variable or expression (& $tool) is known only at run time.
 * - functions: the function definitions among the script's own statements,
 *   with the offset where each ends.
 * Offsets are .NET string indexes, the same as JavaScript's.
 */
const HELPER_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Import-Module Microsoft.PowerShell.Utility
$PSModuleAutoLoadingPreference = 'None'
$utf8 = New-Object System.Text.UTF8Encoding $false
$reader = New-Object System.IO.StreamReader ([Console]::OpenStandardInput()), $utf8
$writer = New-Object System.IO.StreamWriter ([Console]::OpenStandardOutput()), $utf8
$writer.AutoFlush = $true
$programExtensions = @(@($env:PATHEXT -split ';') + '.ps1' | Where-Object { $_ } | ForEach-Object { $_.ToLowerInvariant() })
function Get-Meaning([string]$name) {
  $found = @(Get-Command -Name ([Management.Automation.WildcardPattern]::Escape($name)) -ErrorAction SilentlyContinue)
  if ($found.Count -eq 0) { return $name }
  $info = $found[0]
  if ($info.CommandType -eq 'Alias') { return $info.Definition }
  if ($info.CommandType -eq 'Application' -or $info.CommandType -eq 'ExternalScript') {
    $extension = [IO.Path]::GetExtension($info.Name).ToLowerInvariant()
    if ($extension -and $programExtensions -contains $extension) { return [IO.Path]::GetFileNameWithoutExtension($info.Name) }
  }
  return $info.Name
}
function Get-WordValue($element) {
  if ($element -is [Management.Automation.Language.StringConstantExpressionAst]) { return $element.Value }
  if ($element -is [Management.Automation.Language.CommandParameterAst]) { return $element.Extent.Text }
  if ($element -is [Management.Automation.Language.ConstantExpressionAst]) { return $element.Extent.Text }
  return $null
}
while ($true) {
  $line = $reader.ReadLine()
  if ($null -eq $line) { break }
  $request = ConvertFrom-Json $line
  $answer = @{ id = $request.id }
  try {
    $tokens = $null
    $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseInput([string]$request.command, [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) {
      $answer.parseError = $errors[0].Message
    } else {
      $answer.commands = @(foreach ($command in $ast.FindAll({ $args[0] -is [Management.Automation.Language.CommandAst] }, $true)) {
        $first = $command.CommandElements[0]
        # & { ... } runs a script block, not a program: the commands inside it are found on their own
        if ($first -is [Management.Automation.Language.ScriptBlockExpressionAst]) { continue }
        $words = @(foreach ($element in $command.CommandElements) { ,(Get-WordValue $element) })
        $name = $command.GetCommandName()
        if ($null -eq $name) {
          @{ name = $first.Extent.Text; words = $words; start = $command.Extent.StartOffset; nameAtRunTime = $true }
        } else {
          @{ name = (Get-Meaning $name); words = $words; start = $command.Extent.StartOffset; nameAtRunTime = $false }
        }
      })
      $statements = if ($ast.EndBlock) { $ast.EndBlock.Statements } else { @() }
      $answer.functions = @(foreach ($statement in $statements) {
        if ($statement -is [Management.Automation.Language.FunctionDefinitionAst]) { @{ name = $statement.Name; end = $statement.Extent.EndOffset } }
      })
    }
  } catch {
    $answer.error = $_.Exception.Message
  }
  $writer.WriteLine((ConvertTo-Json $answer -Compress -Depth 6))
}
`;

const HELPER_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(HELPER_SCRIPT, 'utf16le').toString('base64')];

interface PendingRequest {
  resolve: (reading: CommandReading) => void;
  reject: (error: Error) => void;
}

/** Every helper process still running, so they can be ended when Desktop Commander exits */
const liveHelperProcesses = new Set<ChildProcess>();
process.once('exit', () => {
  for (const child of liveHelperProcesses) child.kill();
});

/** One helper process for one PowerShell program, started at its first read and again after it ended */
export class PowerShellHelper {
  private child: ChildProcess | undefined;
  private output = '';
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private timer: NodeJS.Timeout | undefined;
  /** Whether the running helper process has answered yet: until then its start counts in the time limit */
  private answered = false;

  /** args replace the helper's arguments, for a stand-in in tests */
  constructor(private readonly program: string, private readonly args: string[] = HELPER_ARGS) {}

  /** The running helper's process id: undefined before the first read and after the process ended */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Reads one command. It rejects when the helper doesn't answer in time, can't start, or ends first. */
  read(command: string): Promise<CommandReading> {
    const child = this.child ?? this.start();
    const id = this.nextId++;
    return new Promise<CommandReading>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // One time limit for every request waiting: the helper answers in order, so the oldest is due first
      this.timer ??= this.startTimeLimit();
      child.stdin?.write(JSON.stringify({ id, command }) + '\n');
    });
  }

  /** The time limit for the oldest waiting request: longer while the helper hasn't answered since it started */
  private startTimeLimit(): NodeJS.Timeout {
    const limitMs = this.answered ? HELPER_TIMEOUT_MS : HELPER_START_TIMEOUT_MS;
    return setTimeout(() => this.fail(`PowerShell did not answer in ${limitMs / 1000} seconds`), limitMs);
  }

  /** Ends the helper process. The next read starts a new one. */
  stop(): void {
    this.fail('the PowerShell helper was stopped');
  }

  private start(): ChildProcess {
    // The environment commands get, so names are looked up as the command will see them.
    // PowerShell's module analysis cache is off: the helper writes no files (with a home
    // that has no AppData folder, PowerShell would write it into the working folder).
    const env = { ...getCommandEnvironment(), PSModuleAnalysisCachePath: process.platform === 'win32' ? 'NUL' : '/dev/null' };
    const child = spawn(this.program, this.args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    this.output = '';
    this.answered = false;
    liveHelperProcesses.add(child);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.onOutput(child, chunk));
    // Its error text isn't needed: a failed read says what happened. Read so the pipe never fills.
    child.stderr?.resume();
    // Writing to a helper that just ended fails; the 'exit' event below rejects that read
    child.stdin?.on('error', () => {});
    child.on('error', (error) => this.ended(child, `PowerShell could not start: ${error.message}`));
    child.on('exit', (code, signal) => this.ended(child, `PowerShell ended before it answered (${signal ?? `exit code ${code}`})`));
    // The helper never keeps Desktop Commander running; a waiting read's timer does until it's answered
    child.unref();
    for (const stream of [child.stdin, child.stdout, child.stderr]) (stream as { unref?: () => void } | null)?.unref?.();
    return child;
  }

  private onOutput(child: ChildProcess, chunk: string): void {
    if (child !== this.child) return;
    this.output += chunk;
    let newline: number;
    while ((newline = this.output.indexOf('\n')) >= 0) {
      const line = this.output.slice(0, newline).trim();
      this.output = this.output.slice(newline + 1);
      if (line) this.onAnswer(line);
    }
  }

  private onAnswer(line: string): void {
    let answer: any;
    try {
      answer = JSON.parse(line);
    } catch {
      // Not an answer: PowerShell can print other lines; the read's time limit still applies
      return;
    }
    const request = this.pending.get(answer?.id);
    if (!request) return;
    this.pending.delete(answer.id);
    this.answered = true;
    clearTimeout(this.timer);
    this.timer = this.pending.size > 0 ? this.startTimeLimit() : undefined;
    if (typeof answer.error === 'string') {
      request.reject(new Error(`PowerShell could not read the command: ${answer.error}`));
    } else if (typeof answer.parseError === 'string') {
      request.resolve({ commands: [], functions: [], parseError: answer.parseError });
    } else {
      request.resolve({ commands: toCommands(answer.commands), functions: toFunctions(answer.functions) });
    }
  }

  /** The helper process ended or failed to start: every waiting read fails, and the next read starts a new one */
  private ended(child: ChildProcess, reason: string): void {
    liveHelperProcesses.delete(child);
    if (child === this.child) this.fail(reason);
  }

  private fail(reason: string): void {
    const child = this.child;
    this.child = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (child) {
      liveHelperProcesses.delete(child);
      child.kill();
    }
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const request of waiting) request.reject(new Error(reason));
  }
}

function toCommands(value: unknown): FoundCommand[] {
  if (!Array.isArray(value)) return [];
  return value.map((command: any) => ({
    name: String(command.name),
    words: Array.isArray(command.words) ? command.words.map((word: unknown) => (typeof word === 'string' ? word : null)) : [],
    start: Number(command.start),
    nameAtRunTime: command.nameAtRunTime === true,
  }));
}

function toFunctions(value: unknown): DefinedFunction[] {
  if (!Array.isArray(value)) return [];
  return value.map((definition: any) => ({ name: String(definition.name), end: Number(definition.end) }));
}

/** One helper per PowerShell program (Windows PowerShell and PowerShell 7 read some names differently) */
const helpers = new Map<string, PowerShellHelper>();

/** Reads a command for a PowerShell shell ("powershell.exe", "pwsh" or a path), with the same program as the helper */
export function readPowerShellCommands(command: string, shell: string): Promise<CommandReading> {
  const program = resolveProgramPath(shell);
  let helper = helpers.get(program);
  if (!helper) {
    helper = new PowerShellHelper(program);
    helpers.set(program, helper);
  }
  return helper.read(command);
}

/** The process ids of the helpers running now, for tests */
export function runningPowerShellHelpers(): number[] {
  return [...helpers.values()].map((helper) => helper.pid).filter((pid): pid is number => pid !== undefined);
}
