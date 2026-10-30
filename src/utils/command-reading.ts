/**
 * What the command check finds in a command's text. The check reads each
 * command with a reader for the shell that will run it (POSIX shells,
 * PowerShell, cmd). Every reader returns a CommandReading, and checkCommand()
 * in command-manager.ts turns it into a CommandCheck.
 */

/** One command the shell would run */
export interface FoundCommand {
  /**
   * The command's name as the shell reads it, with quotes and escapes removed.
   * In PowerShell it is what the name means there: an alias gives its target
   * (in Windows PowerShell 5.1 "sc" gives "Set-Content"), and a program gives
   * the program's file name. When the name is known only at run time ("$tool"),
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
   * for the rest of the text. A definition inside a subshell, a { } group,
   * another function's body, a pipeline, an if or loop body, after && or ||,
   * or in a PowerShell script block is not listed: it may not exist when a
   * later command runs. Nor is a function the text may remove or hide behind
   * an alias (unset -f halt, Remove-Item function:net, Set-Alias net net.exe),
   * wherever that is written, or one the PowerShell session has an alias of
   * (the user's profile can set one). There are none when the text runs code
   * the reader doesn't read (eval, a file run with ., Invoke-Expression, a
   * method call), which may remove any of them.
   */
  functions: DefinedFunction[];
  /** The parser's message when the text can't be parsed. The two lists are then empty. */
  parseError?: string;
}
