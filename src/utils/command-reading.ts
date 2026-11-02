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

/** What a reader found in a command's text */
export interface CommandReading {
  /** Every command the shell would run, including those nested in others, in the order they start */
  commands: FoundCommand[];
  /** The parser's message when the text can't be parsed. `commands` is then empty. */
  parseError?: string;
}
