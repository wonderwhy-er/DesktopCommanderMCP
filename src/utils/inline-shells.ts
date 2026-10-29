import { getShellType, POSIX_SHELLS, programName, type ShellType } from './shell.js';
import type { FoundCommand } from './command-reading.js';

/**
 * What a shell started by a command runs, by the shell's own rules for its
 * arguments: a command text (bash -c 'sudo ls', pwsh -Command 'net user',
 * powershell -EncodedCommand <base64>, cmd /c net user), a script file
 * (bash deploy.sh, pwsh -File deploy.ps1), or its input (bash -s). The
 * shell around it sees a command text only as an argument, so
 * checkCommand() checks the text like any command, read for the shell that
 * runs it. A script file's commands aren't in the text, so the check notes it.
 * eval and Invoke-Expression run a command text too, in the same shell
 * (eval 'sudo ls', Invoke-Expression 'net user'): see sameShellTexts().
 *
 * The rules are which option gives the command text or the file, and which
 * options take a value. They work on the words a reader found, so they read
 * no shell grammar of their own. A word known only at run time is used as its
 * text ("cd $HOME && sudo ls"), so the programs written in it are still seen.
 * The shell that starts the shell fills that word in before the started shell
 * reads it, so it may hold any command (pwsh -Command $cmd, bash -c "ls $X"):
 * such a command text notes the shell too (file null), as a script file named
 * only at run time does.
 */

/** What a shell runs */
export interface ShellRun {
  /** The command texts it is given, each to be read by the shell the command names */
  texts: string[];
  /**
   * The script file it is given, undefined when it is given none; null when the file, or a part of a command
   * text it is given, is known only at run time
   */
  file?: string | null;
}

// POSIX shell long options that take the next word as their value, so it is neither the script file nor the command
// text; of the one-letter options, o and O do (see posixShellRuns)
const POSIX_SHELL_VALUE_OPTIONS = new Set(['--rcfile', '--init-file']);

/**
 * PowerShell's parameters that take the next word as their value. A
 * parameter may be shortened to any start of its full name (-ex for
 * -ExecutionPolicy); ep, wd, if, of and ea are short names of their own.
 */
const POWERSHELL_VALUE_PARAMETERS = [
  'executionpolicy', 'ep', 'windowstyle', 'workingdirectory', 'wd', 'configurationname', 'configurationfile',
  'custompipename', 'inputformat', 'if', 'outputformat', 'of', 'settingsfile', 'version', 'psconsolefile',
  'encodedarguments', 'ea',
];

/**
 * What a POSIX shell runs: its first word that isn't an option, or what
 * follows -- (bash -o pipefail -x deploy.sh). That word is the command text
 * when -c is among the options (bash -lc, bash -c -e), and the script file
 * otherwise; fish's --command gives the text in the next word. With -s the
 * shell reads its input, and the words are its $1, $2 and so on. Each o and O
 * takes the next word as its value, also in a group of options
 * (bash -euo pipefail deploy.sh, bash -co pipefail 'sudo ls').
 */
function posixShellRuns({ words, wordTexts }: FoundCommand): ShellRun {
  let runsText = false;
  let readsInput = false;
  // A word known only at run time before the first one that isn't an option may be the script file or an
  // option: both readings count, so the shell is noted (file null) and the words after it are read on
  let atRunTime = false;
  // The command text in the word at `at`: one known only at run time, in whole or in part, notes the shell too
  const textAt = (at: number): ShellRun => ({
    texts: at < words.length ? [wordTexts[at]] : [],
    ...(atRunTime || words[at] === null ? { file: null } : {}),
  });
  let first = words.length;
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (word === null) {
      if (runsText) {
        first = i;
        break;
      }
      atRunTime = true;
      continue;
    }
    if (word === '--' || word === '-') {
      first = i + 1;
      break;
    }
    if (word === '--command') return textAt(i + 1);
    if (POSIX_SHELL_VALUE_OPTIONS.has(word)) {
      i++;
      continue;
    }
    if (word.startsWith('-') || word.startsWith('+')) {
      if (/^-[a-zA-Z]*c/.test(word)) runsText = true;
      if (/^-[a-zA-Z]*s/.test(word)) readsInput = true;
      if (/^[-+][a-zA-Z]+$/.test(word)) i += (word.match(/[oO]/g) ?? []).length;
      continue;
    }
    first = i;
    break;
  }
  if (runsText) return textAt(first);
  if (readsInput || atRunTime || first >= words.length) return { texts: [], ...(atRunTime ? { file: null } : {}) };
  return { texts: [], file: words[first] };
}

/**
 * What a PowerShell runs: the words after -Command (-c) joined with spaces,
 * the base64 UTF-16LE text after -EncodedCommand (-e, -enc, -ec), or the
 * script file after -File (-f). Without these, its first word that isn't a
 * parameter is a script file in PowerShell 7; Windows PowerShell runs it, and
 * the words after it, as a command, or as a script file when it is a .ps1.
 * Parameters start with -, -- or /.
 */
function powerShellRuns({ words, wordTexts }: FoundCommand, program: string): ShellRun {
  // A word known only at run time may be a parameter, the command or the script file, so the shell is noted (file null)
  let atRunTime = false;
  // The command texts made of the words `parts`: a part known only at run time notes the shell too
  const textOf = (texts: string[], parts: (string | null | undefined)[]): ShellRun =>
    (atRunTime || parts.includes(null) ? { texts, file: null } : { texts });
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (word === null) {
      atRunTime = true;
      continue;
    }
    const parameter = /^(?:--?|\/)([a-z]+)$/i.exec(word)?.[1].toLowerCase();
    if (parameter === undefined) {
      if (program === 'pwsh' || /\.ps1$/i.test(word)) return { texts: [], file: word };
      return textOf([wordTexts.slice(i).join(' ')], words.slice(i));
    }
    if (parameter === 'ec' || 'encodedcommand'.startsWith(parameter)) {
      const encoded = words[i + 1];
      return textOf(encoded ? [Buffer.from(encoded, 'base64').toString('utf16le')] : [], [encoded]);
    }
    if ('command'.startsWith(parameter)) {
      // -Command - reads the command from standard input
      const text = words[i + 1] === '-' ? '' : wordTexts.slice(i + 1).join(' ');
      return textOf(text ? [text] : [], words.slice(i + 1));
    }
    // -CommandWithArgs: the next word is the command, and the words after it are its $args
    if (parameter === 'cwa' || parameter === 'commandwithargs') return textOf(i + 1 < words.length ? [wordTexts[i + 1]] : [], [words[i + 1]]);
    if ('file'.startsWith(parameter)) return { texts: [], file: words[i + 1] };
    // A parameter's value, also one known only at run time, unless the next word is a parameter (pwsh's -i is a
    // switch, Windows PowerShell's -i takes a value)
    if (POWERSHELL_VALUE_PARAMETERS.some((name) => name.startsWith(parameter)) && i + 1 < words.length && !/^[-/]/.test(words[i + 1] ?? '')) i++;
  }
  return textOf([], []);
}

/**
 * cmd's rule for quotes around the command after /c: when it starts with ",
 * cmd drops that quote and the last one. It keeps both when there are only
 * those two, with whitespace and no special characters between them, and
 * they enclose a program's path (cmd /c "C:\Program Files\x\tool.exe" -v).
 * Whether that file exists depends on where the command runs, so both ways
 * of reading the command are returned then.
 */
function cmdQuoteReadings(line: string, alwaysDropsQuotes: boolean): string[] {
  if (!line.startsWith('"')) return [line];
  const last = line.lastIndexOf('"');
  const dropped = line.slice(1, last) + line.slice(last + 1);
  const keeps = !alwaysDropsQuotes && (line.match(/"/g) ?? []).length === 2 && /^"[^"&<>()@^|]*\s[^"&<>()@^|]*"/.test(line);
  return keeps ? [line, dropped] : [dropped];
}

/**
 * What cmd runs: what follows /c, /k or /r, after other switches such as /q,
 * /d or /v:on. Switches can be written together (/q/c), and the command can
 * start in the same word (/cnet). cmd gets the words as one command line,
 * where a word with whitespace in it is in quotes, as PowerShell and Git Bash
 * pass it.
 */
function cmdRuns({ words, wordTexts }: FoundCommand): ShellRun {
  // Each word is a switch or a part of the command, so one known only at run time may hold any command (cmd $opts)
  const noted = words.slice(1).includes(null) ? { file: null } : {};
  let alwaysDropsQuotes = false;
  for (let i = 1; i < wordTexts.length; i++) {
    const word = wordTexts[i];
    if (!word.startsWith('/')) break;
    const run = /^((?:\/(?![ckr])[^/]*)*)\/[ckr](.*)$/is.exec(word);
    // /s: cmd drops the quotes around the command in every case
    if (/\/s(?:\/|$)/i.test(run ? run[1] : word)) alwaysDropsQuotes = true;
    if (!run) continue;
    const lineWords = run[2] ? [run[2], ...wordTexts.slice(i + 1)] : wordTexts.slice(i + 1);
    if (lineWords.length === 0) break;
    const line = lineWords.map((lineWord) => (lineWord === '' || /\s/.test(lineWord) ? `"${lineWord}"` : lineWord)).join(' ');
    return { texts: cmdQuoteReadings(line, alwaysDropsQuotes), ...noted };
  }
  return { texts: [], ...noted };
}

/**
 * The command texts eval (in a POSIX shell) or Invoke-Expression (in
 * PowerShell, also written iex) runs in the shell it is in. eval joins its
 * words with spaces. Invoke-Expression runs one text, its Command; PowerShell
 * binds one of the words that aren't parameter names to it, and the others
 * may be values of other parameters (iex -ea 0 'net user'), so each of them
 * is a text. Null when a text is known only at run time, in whole or in part
 * (eval "$CMD", eval "ls $X"), or comes from the pipeline ('net user' | iex),
 * so the check can't read it; none for any other command.
 */
export function sameShellTexts({ name, words }: FoundCommand, shellType: ShellType): string[] | null {
  const program = programName(name);
  if (shellType === 'posix' && program === 'eval') {
    const args = words[1] === '--' ? words.slice(2) : words.slice(1);
    if (args.includes(null)) return null;
    return args.length > 0 ? [args.join(' ')] : [];
  }
  if (shellType === 'powershell' && program === 'invoke-expression') {
    const texts = words.slice(1).filter((word) => word === null || !word.startsWith('-'));
    if (texts.length === 0 || texts.includes(null)) return null;
    return texts as string[];
  }
  return [];
}

/**
 * What the shell `found` starts runs: nothing when found isn't a shell. Its
 * kind of shell is taken from its name as found, as checkCommand() takes the
 * reader for a text from the shell it is given.
 */
export function shellRuns(found: FoundCommand): ShellRun {
  const program = programName(found.name);
  switch (getShellType(found.name)) {
    case 'powershell':
      return powerShellRuns(found, program);
    case 'cmd':
      return cmdRuns(found);
    default:
      // getShellType() takes every other program for a POSIX shell
      return POSIX_SHELLS.has(program) ? posixShellRuns(found) : { texts: [] };
  }
}
