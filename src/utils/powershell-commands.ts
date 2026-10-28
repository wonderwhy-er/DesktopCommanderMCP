import { spawn, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import type { Socket } from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import { getCommandEnvironment, resolveProgramPath } from './shell.js';
import type { CommandReading } from './command-reading.js';

/**
 * The command check's reader for PowerShell. No JavaScript parser reads
 * PowerShell correctly (here-strings, @{ } tables, & $var), so a helper
 * PowerShell process reads each command with PowerShell's own parser. It
 * starts at the first PowerShell check, so nothing runs for users who never
 * run PowerShell commands, and it is kept running: a check then takes a few
 * milliseconds instead of PowerShell's start (about a second for Windows
 * PowerShell). It is not a terminal session, so list_sessions never shows it.
 * It loads the user's profile, as the PowerShell a command runs in does
 * (start_process starts it without -NoProfile), so it knows the profile's
 * aliases.
 */

/** How long a check waits for a running helper's answer. A helper that doesn't answer is stopped, and the check fails. */
export const HELPER_TIMEOUT_MS = 5000;

/**
 * How long the first check waits after a helper starts, PowerShell's start
 * and the user's profile included: about a second for Windows PowerShell,
 * longer on a busy machine or with a slow profile
 */
export const HELPER_START_TIMEOUT_MS = 15000;

/** The folder Desktop Commander is installed in, where its own node:local process runs too */
const mcpRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The helper, run with -EncodedCommand. It reads one JSON request per line
 * ({ id, token, command }) and writes one JSON answer per line. It only
 * parses the command and looks names up with Get-Command; it never runs the
 * command.
 * Module autoloading is off so that looking up a name never imports a module.
 * Each CommandAst is a command, also inside script blocks and functions. Its
 * name is what it means in this PowerShell: an alias gives its target, a
 * program or script its file name as found (net.exe). A name Get-Command
 * doesn't know stays as written. A name from a variable or expression
 * (& $tool) is known only at run time.
 * For a command that means Start-Process, filePaths are the programs it may
 * start: the word its FilePath parameter takes as this PowerShell binds the
 * command (with the Management module, imported the first time), and a
 * splatted @params, which may hold FilePath. The binder can't see into
 * @params and doesn't know -- (the end of the parameters), so the command is
 * also bound with those words left out.
 * The functions are the definitions among the script's own statements, with
 * the offset where each ends. There are none when the text has a { } script
 * block written as a value, which may run where the functions don't exist
 * (Start-Job runs it in another process), or something that may remove a
 * function or hide it behind an alias, which comes before a function: a
 * $function: or $alias: variable ($function:net = $null), Set-Alias, New-Alias
 * or Import-Alias, a word naming the function or alias drive or provider
 * (Remove-Item function:net, New-Item alias:net, New-PSDrive -PSProvider
 * Function), or an item or content cmdlet whose path is known only at run
 * time or comes from the pipeline ('function:net' | Remove-Item; Set-Content
 * gives a function a new body). Nor when it runs code the helper doesn't
 * read: Invoke-Expression, Import-Module, Add-Type, a script file, a name
 * known only at run time, a method call ([scriptblock]::Create(...).Invoke())
 * or ForEach-Object calling one. Nor is a function the session has an alias
 * of, such as one the user's profile sets.
 * Offsets are .NET string indexes, the same as JavaScript's.
 * The profile runs first, and may print anything and define functions and
 * aliases with any name. So the helper writes an empty line before its first
 * answer (text the profile printed without a newline ends there), puts the
 * request's token in each answer (the reader takes no other line for one),
 * calls each cmdlet by its module's name, which no function or alias
 * replaces, and keeps its own functions in variables ($getMeaning), which no
 * alias replaces either.
 */
const HELPER_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Microsoft.PowerShell.Core\\Import-Module Microsoft.PowerShell.Utility
$PSModuleAutoLoadingPreference = 'None'
$utf8 = Microsoft.PowerShell.Utility\\New-Object System.Text.UTF8Encoding $false
$reader = Microsoft.PowerShell.Utility\\New-Object System.IO.StreamReader ([Console]::OpenStandardInput()), $utf8
$writer = Microsoft.PowerShell.Utility\\New-Object System.IO.StreamWriter ([Console]::OpenStandardOutput()), $utf8
$writer.AutoFlush = $true
$writer.WriteLine()
# The helper's own functions are script blocks in variables: an alias with a function's name, such as one the profile sets, comes before the function
$getMeaning = {
  param([string]$name)
  $found = @(Microsoft.PowerShell.Core\\Get-Command -Name ([Management.Automation.WildcardPattern]::Escape($name)) -ErrorAction SilentlyContinue)
  if ($found.Count -eq 0) { return $name }
  if ($found[0].CommandType -eq 'Alias') { return $found[0].Definition }
  return $found[0].Name
}
$getWordValue = {
  param($element)
  if ($element -is [Management.Automation.Language.StringConstantExpressionAst]) { return $element.Value }
  if ($element -is [Management.Automation.Language.CommandParameterAst]) { return $element.Extent.Text }
  if ($element -is [Management.Automation.Language.ConstantExpressionAst]) { return $element.Extent.Text }
  return $null
}
$managementImported = $false
$getFilePaths = {
  param($command)
  if (-not $script:managementImported) {
    Microsoft.PowerShell.Core\\Import-Module Microsoft.PowerShell.Management
    $script:managementImported = $true
  }
  $programs = @()
  $text = $command.Extent.Text
  foreach ($element in $command.CommandElements) {
    $splatted = $element -is [Management.Automation.Language.VariableExpressionAst] -and $element.Splatted
    if ($splatted) { $programs += @{ word = $null; written = $element.Extent.Text } }
    if ($splatted -or $element.Extent.Text -eq '--') {
      $at = $element.Extent.StartOffset - $command.Extent.StartOffset
      $text = $text.Remove($at, $element.Extent.Text.Length).Insert($at, ' ' * $element.Extent.Text.Length)
    }
  }
  $bindings = @($command)
  if ($text -ne $command.Extent.Text) {
    $bindings += [Management.Automation.Language.Parser]::ParseInput($text, [ref]$null, [ref]$null).Find({ $args[0] -is [Management.Automation.Language.CommandAst] }, $true)
  }
  foreach ($binding in $bindings) {
    # A command PowerShell can't bind is one it refuses to run
    try { $filePath = [Management.Automation.Language.StaticParameterBinder]::BindCommand($binding, $true).BoundParameters['FilePath'] } catch { continue }
    if ($null -eq $filePath -or ($filePath.Value -is [Management.Automation.Language.VariableExpressionAst] -and $filePath.Value.Splatted)) { continue }
    $asWritten = $filePath.Value.Extent.Text
    if (-not ($programs | Microsoft.PowerShell.Core\\Where-Object { $_.written -eq $asWritten })) { $programs += @{ word = (& $getWordValue $filePath.Value); written = $asWritten } }
  }
  return $programs
}
$testRemovesFunction = {
  param($found)
  if ($found.name -in 'Set-Alias', 'New-Alias', 'Import-Alias') { return $true }
  $pathAtRunTime = $false
  $knownPaths = 0
  for ($i = 1; $i -lt $found.words.Count; $i++) {
    $word = $found.words[$i]
    if ($null -eq $word) { $pathAtRunTime = $true }
    elseif ($word -match '\\b(function|alias)\\b') { return $true }
    elseif (-not $word.StartsWith('-')) { $knownPaths++ }
  }
  return ($found.name -like '*-Item' -or $found.name -like '*-Content') -and ($pathAtRunTime -or $knownPaths -eq 0)
}
$testRunsUnreadCode = {
  param($found)
  if ($found.nameAtRunTime -or $found.name -in 'Invoke-Expression', 'Import-Module', 'Add-Type') { return $true }
  # ForEach-Object InvokeScript 'text' calls each object's method
  if ($found.name -eq 'ForEach-Object') {
    $values = 0
    for ($i = 1; $i -lt $found.words.Count; $i++) { if (-not "$($found.words[$i])".StartsWith('-')) { $values++ } }
    if ($values -gt 1) { return $true }
  }
  # A script file: .ps1 or .psm1, or a path without an extension (. ./lib runs lib.ps1)
  $leaf = $found.name.Substring($found.name.LastIndexOfAny([char[]]'\\/') + 1)
  return $leaf -like '*.ps1' -or $leaf -like '*.psm1' -or ($leaf -ne $found.name -and $leaf -notlike '*.*')
}
while ($true) {
  $line = $reader.ReadLine()
  if ($null -eq $line) { break }
  $request = Microsoft.PowerShell.Utility\\ConvertFrom-Json $line
  $answer = @{ id = $request.id; token = $request.token }
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
        $words = @(foreach ($element in $command.CommandElements) { ,(& $getWordValue $element) })
        $written = @(foreach ($element in $command.CommandElements) { $element.Extent.Text })
        $name = $command.GetCommandName()
        if ($null -eq $name) {
          @{ name = $first.Extent.Text; words = $words; written = $written; start = $command.Extent.StartOffset; nameAtRunTime = $true }
        } else {
          $found = @{ name = (& $getMeaning $name); words = $words; written = $written; start = $command.Extent.StartOffset; nameAtRunTime = $false }
          if ($found.name -eq 'Start-Process') { $found.filePaths = @(& $getFilePaths $command) }
          $found
        }
      })
      $isBlockValue = { $args[0] -is [Management.Automation.Language.ScriptBlockExpressionAst] }
      $isFunctionOrAliasVariable = { $args[0] -is [Management.Automation.Language.VariableExpressionAst] -and $args[0].VariablePath.DriveName -in 'function', 'alias' }
      $isMethodCall = { $args[0] -is [Management.Automation.Language.InvokeMemberExpressionAst] }
      $removers = @($answer.commands | Microsoft.PowerShell.Core\\Where-Object { (& $testRemovesFunction $_) -or (& $testRunsUnreadCode $_) })
      $functionsMayGo = $removers.Count -gt 0 -or $ast.Find($isBlockValue, $true) -or $ast.Find($isFunctionOrAliasVariable, $true) -or $ast.Find($isMethodCall, $true)
      $statements = if ($ast.EndBlock -and -not $functionsMayGo) { $ast.EndBlock.Statements } else { @() }
      $answer.functions = @(foreach ($statement in $statements) {
        if ($statement -isnot [Management.Automation.Language.FunctionDefinitionAst]) { continue }
        # An alias of its name, such as one the profile sets, comes before the function
        $alias = Microsoft.PowerShell.Utility\\Get-Alias -Name ([Management.Automation.WildcardPattern]::Escape($statement.Name)) -ErrorAction SilentlyContinue
        if (-not $alias) { @{ name = $statement.Name; end = $statement.Extent.EndOffset } }
      })
    }
  } catch {
    $answer.error = $_.Exception.Message
  }
  $writer.WriteLine((Microsoft.PowerShell.Utility\\ConvertTo-Json $answer -Compress -Depth 6))
}
`;

const HELPER_ARGS = ['-NonInteractive', '-EncodedCommand', Buffer.from(HELPER_SCRIPT, 'utf16le').toString('base64')];

interface PendingRequest {
  resolve: (reading: CommandReading) => void;
  reject: (error: Error) => void;
}

/** One helper process for one PowerShell program, started at its first read and again after it ended */
export class PowerShellHelper {
  private child: ChildProcess | undefined;
  private output = '';
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private timer: NodeJS.Timeout | undefined;
  /** Whether the running helper process has answered yet: until then its start counts in the time limit */
  private answered = false;
  /** Made at each start and sent with every request; an answer has it, a line the profile printed doesn't */
  private token = '';

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
      child.stdin?.write(JSON.stringify({ id, token: this.token, command }) + '\n');
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
    // PowerShell's module analysis cache is off, so the helper doesn't write it (with a home
    // that has no AppData folder, PowerShell would write it into the working folder).
    const env = { ...getCommandEnvironment(), PSModuleAnalysisCachePath: process.platform === 'win32' ? 'NUL' : '/dev/null' };
    // Not in the caller's working folder: the helper keeps running, and Windows can't delete a folder a process is in
    const child = spawn(this.program, this.args, { cwd: mcpRoot, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    this.output = '';
    this.answered = false;
    this.token = randomBytes(16).toString('hex');
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
    // The pipes are sockets: unref() keeps them from holding Desktop Commander open
    (child.stdin as Socket).unref();
    (child.stdout as Socket).unref();
    (child.stderr as Socket).unref();
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
    // Only the helper has this start's token: the profile ran before the helper read a request
    const request = answer?.token === this.token ? this.pending.get(answer.id) : undefined;
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
      request.resolve({ commands: answer.commands, functions: answer.functions });
    }
  }

  /** The helper process ended or failed to start: every waiting read fails, and the next read starts a new one */
  private ended(child: ChildProcess, reason: string): void {
    if (child === this.child) this.fail(reason);
  }

  private fail(reason: string): void {
    const child = this.child;
    this.child = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    child?.kill();
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const request of waiting) request.reject(new Error(reason));
  }
}

/** One helper per PowerShell program (Windows PowerShell and PowerShell 7 read some names differently) */
const helpers = new Map<string, PowerShellHelper>();

/**
 * Reads a command for a PowerShell shell ("powershell.exe", "pwsh" or a path),
 * with the same program as the helper. checkCommand() has made sure it's there.
 */
export function readPowerShellCommands(command: string, shell: string): Promise<CommandReading> {
  const program = path.resolve(resolveProgramPath(shell));
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
