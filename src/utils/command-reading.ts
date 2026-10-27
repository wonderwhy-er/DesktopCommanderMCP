/**
 * What the command check finds in a command's text. The check reads each
 * command with a reader for the shell that will run it (POSIX shells,
 * PowerShell, cmd). Every reader returns a CommandReading, and checkCommand()
 * in command-manager.ts turns it into a CommandCheck.
 */

/** The kinds of shell a command can run in. Each kind has its own reader. */
export type ShellType = 'posix' | 'powershell' | 'cmd';

/** One command the shell would run */
export interface FoundCommand {
  /**
   * The command's name as the shell reads it, with quotes and escapes removed.
   * In PowerShell it is what the name means there: an alias gives its target
   * (in Windows PowerShell 5.1 "sc" gives "Set-Content"), and a program gives
   * the program's name. When the name is known only at run time ("$tool"),
   * this is the name as it is written in the text.
   */
  name: string;
  /**
   * The command's words as the shell reads them, starting with the name as
   * written (before PowerShell gives its meaning). A word known only at run
   * time, such as "$CMD" or "$(date)", is null.
   */
  words: (string | null)[];
  /** Where the command starts: an index into the command's text */
  start: number;
  /** True when the name is known only at run time: a variable, or the output of another command */
  nameAtRunTime: boolean;
}

/** A function the command's text defines */
export interface DefinedFunction {
  /** The function's name as written */
  name: string;
  /** Where the definition ends: the index just past its last character */
  end: number;
}

/** What a reader found in a command's text */
export interface CommandReading {
  /** Every command the shell would run, including those nested in others, in the order they start */
  commands: FoundCommand[];
  /**
   * The functions defined by the text's own statements, which stay defined
   * for the rest of the text. A definition inside a subshell, another
   * function's body, a pipeline, an if or loop body, after && or ||, or in a
   * PowerShell script block is not listed: it may not exist when a later
   * command runs.
   */
  functions: DefinedFunction[];
  /** The parser's message when the text can't be parsed. The two lists are then empty. */
  parseError?: string;
}

/**
 * Reads a command's text for the given shell (the program, such as
 * "powershell.exe" or "/bin/zsh"). It throws when it can't answer, for example
 * when the PowerShell helper doesn't answer in time.
 */
export type CommandReader = (command: string, shell: string) => Promise<CommandReading>;

/**
 * The check's answer for one command. `commands` holds the names it found,
 * for telemetry.
 * - allowed: no blocked program runs.
 * - blocked: `name` is the blockedCommands entry that one of the programs matched.
 * - unseen: allowed, but some program is chosen only when the command runs
 *   (eval "$CMD", Invoke-Expression $cmd, & $tool) or is in a script file
 *   (bash deploy.sh). `unseen` holds what hides each one: "eval",
 *   "Invoke-Expression", "$tool", "deploy.sh".
 * - failed: the check couldn't read the command, and `reason` says why.
 */
export type CommandCheck =
  | { verdict: 'allowed'; commands: string[] }
  | { verdict: 'blocked'; name: string; commands: string[] }
  | { verdict: 'unseen'; unseen: string[]; commands: string[] }
  | { verdict: 'failed'; reason: string; commands: string[] };
