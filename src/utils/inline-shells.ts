import { getShellType, POSIX_SHELLS, programName, type ShellType } from './shell.js';
import type { FoundCommand } from './command-reading.js';
import { sameShellProgramReadings, shellOptionReadings, textProgramReadings, type OptionReadings } from './command-wrappers.js';

/**
 * What a shell started by a command runs, by the shell's own rules for its
 * arguments: a command text (bash -c 'sudo ls', pwsh -Command 'net user',
 * powershell -EncodedCommand <base64>, cmd /c net user), a script file
 * (bash deploy.sh, pwsh -File deploy.ps1), or its input (bash -s). The
 * shell around it sees a command text only as an argument, so
 * checkCommand() checks the text like any command, read for the shell that
 * runs it. A script file's commands aren't in the text, so the check notes it.
 * eval and Invoke-Expression run a command text too, in the same shell
 * (eval 'sudo ls', Invoke-Expression 'net user'), and their texts follow the
 * same rules: see sameShellTexts(). So do the programs that run one command
 * text in a shell (su -c 'sudo ls', watch 'sudo ls': see TEXT_PROGRAMS in
 * command-wrappers.ts).
 *
 * The rules are which option gives the command text or the file, and which
 * options take a value. They work on the words a reader found, so they read
 * no shell grammar of their own. A POSIX shell's options are read by the
 * wrappers' reader, from its rules there (see command-wrappers.ts), in every
 * way they can be read. A word known only at run time is used as its
 * text ("cd $HOME && sudo ls"), so the programs written in it are still seen.
 * The shell that starts the shell fills that word in before the started shell
 * reads it, so it may hold any command (pwsh -Command $cmd, bash -c "ls $X"):
 * such a command text notes the shell too (file null), as a script file named
 * only at run time does.
 */

/** What a shell runs, or eval or Invoke-Expression in the shell they are in */
export interface ShellRun {
  /** The command texts it is given, each to be read by the shell that runs it */
  texts: string[];
  /**
   * The script file it is given, undefined when it is given none; null when the file, or a part of a command
   * text it is given, is known only at run time, or when its options can be read as naming different files
   */
  file?: string | null;
  /** The shell that reads its texts, when it isn't the program itself: sh for su -c's, cmd for runas's command line */
  shell?: string;
}

/**
 * PowerShell's parameters that take the next word as their value, whatever
 * it is (-wd /home/me). A parameter may be shortened to any start of its
 * full name (-ex for -ExecutionPolicy); ep, wd, if, of and ea are short names
 * of their own.
 */
const POWERSHELL_VALUE_PARAMETERS = [
  'executionpolicy', 'ep', 'windowstyle', 'workingdirectory', 'wd', 'configurationname', 'configurationfile',
  'custompipename', 'inputformat', 'if', 'outputformat', 'of', 'settingsfile', 'version', 'psconsolefile',
  'encodedarguments', 'ea',
];

/** PowerShell's switches, in pwsh and in Windows PowerShell */
const POWERSHELL_SWITCHES = [
  'help', 'login', 'noexit', 'nologo', 'noninteractive', 'noprofile', 'noprofileloadtime', 'interactive', 'sta', 'mta',
  'servermode', 'socketservermode', 'v2socketservermode', 'namedpipeservermode', 'sshservermode',
  'removeworkingdirectorytrailingcharacter',
];

/** Every PowerShell parameter: those above, and those that give the command text or the script file */
const POWERSHELL_PARAMETERS = [
  ...POWERSHELL_VALUE_PARAMETERS, ...POWERSHELL_SWITCHES, 'command', 'commandwithargs', 'cwa', 'encodedcommand', 'ec', 'file',
];

/**
 * The name a word gives a PowerShell parameter, written -Name, --Name or /Name, in lowercase. PowerShell takes an
 * en dash, an em dash or a horizontal bar (–, —, ―) for - too, and a second dash only if it is the same
 */
const parameterName = (word: string): string | undefined =>
  /^(?:([-\u2013\u2014\u2015])\1?|\/)([a-z]+)$/i.exec(word)?.[2].toLowerCase();

/** Whether a word is written as a PowerShell parameter is, with the start of a parameter's name (/c, not /tmp) */
function isPowerShellParameter(word: string | null): boolean {
  const name = word === null ? undefined : parameterName(word);
  return name !== undefined && POWERSHELL_PARAMETERS.some((known) => known.startsWith(name));
}

/**
 * What a POSIX shell runs, by its options as the wrappers' reader reads them
 * (shellOptionReadings()): the command text, which is the first word after
 * bash's options with -c (bash -lc make, bash -c -e 'sudo ls') or the value
 * of fish's -c, --command or -C (fish -C : -c 'sudo ls'), or else the script
 * file, the first word after the options (bash -o pipefail -x deploy.sh).
 * With bash -s or fish -c, the words after the options are the command's
 * arguments. Where the options can be read more than one way, every reading
 * counts.
 */
function posixShellRuns(found: FoundCommand, program: string): ShellRun {
  return readingsRun(shellOptionReadings(program, found.words), found, true);
}

/**
 * What a program that runs one command text in a shell runs (su -c 'sudo
 * ls', watch 'sudo ls': see TEXT_PROGRAMS in command-wrappers.ts), and the
 * shell that reads it. The words after its options are no script file: a
 * user, a file or a group.
 */
function textProgramRuns(found: FoundCommand, program: string): ShellRun {
  const text = textProgramReadings(program, found.words);
  return text ? { ...readingsRun(text.readings, found, false), shell: text.shell } : { texts: [] };
}

/**
 * What the readings of a command's options give it to run: its command texts,
 * each once also when more than one reading finds it, and one known only at
 * run time as written; and for a shell (`script`), its script file. A part
 * known only at run time, in a text or the word after the options, may hold
 * any command, and so may a script file the readings don't agree on, and
 * texts that aren't among its words at all (parallel :::: jobs.txt): the
 * command is noted then (file null).
 */
function readingsRun({ operands, texts, hidden }: OptionReadings, { words, wordTexts }: FoundCommand, script: boolean): ShellRun {
  const textOf = ({ text, at, to }: OptionReadings['texts'][number]): string =>
    (at === undefined ? text ?? '' : to !== undefined ? wordTexts.slice(at, to).join(' ') : wordTexts[at]);
  const after = [...new Set(operands.filter((at) => at < words.length).map((at) => words[at]))];
  const atRunTime = hidden || texts.some(({ text, at }) => at !== undefined && text === null) || after.includes(null)
    || (script && after.length > 1);
  const file = script && after.length === 1 ? { file: after[0] } : {};
  return { texts: [...new Set(texts.map(textOf))], ...(atRunTime ? { file: null } : file) };
}

/**
 * What a PowerShell runs: the words after -Command (-c) joined with spaces,
 * the base64 UTF-16LE text after -EncodedCommand (-e, -enc, -ec), or the
 * script file after -File (-f). Without these, its first word that isn't a
 * parameter is a script file in PowerShell 7; Windows PowerShell runs it, and
 * the words after it, as a command, or as a script file when it is a .ps1.
 * Parameters start with -, -- or / (pwsh takes –, — and ― for -, and Windows
 * PowerShell, whose parser isn't open source, may too, so there such a word
 * is read as no parameter as well), and a parameter's value is the next word,
 * whatever it is (-wd /home/me). A word known only at run time where a
 * parameter can be may be any of them: a switch, a parameter with a value,
 * -Command or -File. Where the check can't tell which word is a value,
 * every reading counts.
 */
function powerShellRuns({ words, wordTexts }: FoundCommand, program: string): ShellRun {
  const texts: string[] = [];
  // The script files the readings name, and null for a part known only at run time, which may hold any command
  const files = new Set<string | null>();
  const read = new Set<number>();
  // Adds the command texts made of the words `parts`
  const addTexts = (found: string[], parts: (string | null | undefined)[]): void => {
    texts.push(...found);
    if (parts.includes(null)) files.add(null);
  };
  // Reads the words from the `from`th on, as PowerShell does
  const readFrom = (from: number): void => {
    if (read.has(from)) return;
    read.add(from);
    for (let i = from; i < words.length; i++) {
      const word = words[i];
      if (word === null) {
        // Such a word may be any parameter, the command or the script file, so the shell is noted. As -Command, the
        // words after it are the command text (pwsh $mode net user); as a parameter with a value, the next word is that
        files.add(null);
        if (i + 1 < words.length) texts.push(wordTexts.slice(i + 1).join(' '));
        readFrom(i + 2);
        continue;
      }
      const parameter = parameterName(word);
      if (parameter === undefined || (program !== 'pwsh' && /^[\u2013\u2014\u2015]/.test(word))) {
        if (program === 'pwsh' || /\.ps1$/i.test(word)) files.add(word);
        else addTexts([wordTexts.slice(i).join(' ')], words.slice(i));
        if (parameter === undefined) return;
      }
      if (parameter === 'ec' || 'encodedcommand'.startsWith(parameter)) {
        const encoded = words[i + 1];
        return addTexts(encoded ? [Buffer.from(encoded, 'base64').toString('utf16le')] : [], [encoded]);
      }
      if ('command'.startsWith(parameter)) {
        // -Command - reads the command from standard input
        const text = words[i + 1] === '-' ? '' : wordTexts.slice(i + 1).join(' ');
        return addTexts(text ? [text] : [], words.slice(i + 1));
      }
      // -CommandWithArgs: the next word is the command, and the words after it are its $args
      if (parameter === 'cwa' || parameter === 'commandwithargs') return addTexts(i + 1 < words.length ? [wordTexts[i + 1]] : [], [words[i + 1]]);
      if ('file'.startsWith(parameter)) {
        if (i + 1 < words.length) files.add(words[i + 1]);
        return;
      }
      // A parameter's value, also one known only at run time. When the next word is written as a parameter is (-wd /c:
      // Git Bash's C: drive, and -Command's short form), or the parameter may be a switch (pwsh's -i is a switch,
      // Windows PowerShell's -i takes a value), it is read as the next parameter too
      if (POWERSHELL_VALUE_PARAMETERS.some((name) => name.startsWith(parameter)) && i + 1 < words.length) {
        if (isPowerShellParameter(words[i + 1]) || POWERSHELL_SWITCHES.some((name) => name.startsWith(parameter))) readFrom(i + 1);
        i++;
      }
    }
  };
  readFrom(1);
  // A script file the readings don't agree on may hold any command too
  const file = [...files];
  return { texts: [...new Set(texts)], ...(file.length === 0 ? {} : { file: file.length === 1 ? file[0] : null }) };
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
 * What eval (in a POSIX shell) or Invoke-Expression (in PowerShell, also
 * written iex) runs in the shell it is in: its command texts. eval joins its
 * words with spaces. Invoke-Expression runs one text, its Command; PowerShell
 * binds one of the words that aren't parameter names to it, and the others
 * may be values of other parameters (iex -ea 0 'net user'), so each of them
 * is a text. Written with a colon, the parameter and its value are one word
 * (iex -Command:'net user'), which runs what iex given that value runs. A
 * text with a part known only at run time is read as written,
 * as the text of bash -c is, so the programs written in it are checked
 * (eval "cd $HOME && sudo ls"). That part may hold any command, so file is
 * null then, and the command is noted; so is a text that comes from the
 * pipeline ('net user' | iex). gsudo, in any shell, runs its command in the
 * shell it was started from too (gsudo 'net user'), and gsudo !! runs the
 * last command again, which the check can't see, so it is noted. No texts
 * for any other command.
 */
export function sameShellTexts(found: FoundCommand, shellType: ShellType): ShellRun {
  const { name, words, wordTexts } = found;
  const program = programName(name);
  const sameShell = sameShellProgramReadings(program, words);
  if (sameShell) {
    const run = readingsRun(sameShell, found, false);
    return run.texts.includes('!!') ? { texts: [], file: null } : run;
  }
  if (shellType === 'posix' && program === 'eval') {
    const from = words[1] === '--' ? 2 : 1;
    return {
      texts: from < words.length ? [wordTexts.slice(from).join(' ')] : [],
      ...(words.slice(from).includes(null) ? { file: null } : {}),
    };
  }
  if (shellType === 'powershell' && program === 'invoke-expression') {
    // Where the words that aren't parameter names are; with none, the text comes from the pipeline
    const at = words.flatMap((word, i) => (i > 0 && (word === null || !/^[-\u2013\u2014\u2015]/.test(word)) ? [i] : []));
    // -Command:'net user' (-c: 'net user'): the command without the parameter's name runs the same, and is shorter
    const withColon = words.flatMap((word) => {
      const colon = word === null ? null : /^[-\u2013\u2014\u2015]([a-z]+):(.*)$/is.exec(word);
      return colon && 'command'.startsWith(colon[1].toLowerCase()) ? [`${wordTexts[0]} ${colon[2]}`] : [];
    });
    return {
      texts: [...at.map((i) => wordTexts[i]), ...withColon],
      ...((at.length === 0 && withColon.length === 0) || at.some((i) => words[i] === null) ? { file: null } : {}),
    };
  }
  return { texts: [] };
}

/**
 * What the shell `found` starts runs, or the program that runs one command
 * text in a shell (su -c 'sudo ls'): nothing for any other command. Its kind
 * of shell is taken from its name as found, as checkCommand() takes the
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
      return POSIX_SHELLS.has(program) ? posixShellRuns(found, program) : textProgramRuns(found, program);
  }
}
