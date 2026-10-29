import { programName, type ShellType } from './shell.js';
import type { FoundCommand } from './command-reading.js';

/**
 * The command check's rules for wrappers: commands that start another
 * program, as env does in "env sudo ls", which runs sudo. checkCommand()
 * follows each wrapper to the program it starts, past the wrapper's own
 * options (timeout 5 reboot, nice -n 10 dd, sudo -u root id), and checks that
 * program like any other command. A wrapper can start another wrapper: env
 * nohup sudo ls runs sudo.
 * - env, nohup, xargs, timeout, nice, stdbuf, setsid, chroot, sudo, doas,
 *   pkexec, busybox and wsl are programs, so they start the program after
 *   them from every shell: chroot after its new root, busybox its own program
 *   of that name, wsl in Linux. env -S 'sudo ls' runs sudo too: env splits
 *   -S's text into more of its own words. Windows' timeout /t 5 starts
 *   nothing: it only waits;
 * - exec and command are commands of the POSIX shells;
 * - Start-Process (also written start or saps) is PowerShell's: the PowerShell
 *   reader gives the programs it starts, as PowerShell itself binds its
 *   FilePath (FoundCommand's filePaths);
 * - start is cmd's (cmd's call is the cmd reader's, as if and else are).
 *
 * Where the check can't tell which word is the program, every reading counts,
 * and the check refuses the command when any of them runs a blocked program.
 * An option the rules don't list may take the next word as its value or not
 * (nice -X 10 sudo ls runs 10 or sudo). A word known only at run time where an
 * option could be ($OPTS in nice $OPTS make) may be the program, or an option
 * with or without a value: it is a program known only at run time, and either
 * of the next two words may be the program too.
 */

/**
 * A wrapper's options. The programs read them with getopt, and the shells
 * read exec's and command's the same way: -abc is -a -b -c, a value follows
 * its option in the same word (-uroot, --user=root) or in the next one (-u
 * root, --user root), a long option may be shortened while it stays
 * unambiguous (--us), and -- ends the options.
 */
interface PosixWrapper {
  /** The one-letter options that take a value */
  letters?: string;
  /** The one-letter options whose value can only be in the same word (xargs -i{}, and nice -10, the old nice -n 10) */
  attachedLetters?: string;
  /** The one-letter options that take no value */
  flags?: string;
  /** The long options that take a value */
  long?: string[];
  /** The long options that take no value, or one only after = (env --block-signal=PIPE) */
  longFlags?: string[];
  /** The options with which no program runs: command -v sudo only says what sudo is */
  noProgram?: string;
  /** The first words, in any case, after which no program runs: Windows' timeout /t 5 only waits */
  noProgramWords?: string[];
  /** How many words after the options come before the program: timeout's duration */
  before?: number;
  /** Whether NAME=VALUE words before the program set its environment (env, sudo) */
  assignments?: boolean;
  /**
   * The options whose value is a command text: env -S 'sudo ls' and --split-string='sudo ls' run sudo, as env
   * splits the text into more of its own words
   */
  texts?: { letters: string; long: string[] };
}

/**
 * The wrappers that are programs, with their options in GNU, BSD and macOS
 * (and Windows' sudo); doas's in OpenBSD, pkexec's in polkit, setsid's in
 * util-linux, and busybox's and wsl's in their own usage text
 */
const PROGRAMS = new Map<string, PosixWrapper>([
  ['env', {
    letters: 'uCPLUa', flags: 'i0v', long: ['unset', 'chdir', 'argv0'],
    longFlags: ['ignore-environment', 'null', 'debug', 'block-signal', 'default-signal', 'ignore-signal', 'list-signal-handling', 'help', 'version'],
    assignments: true, texts: { letters: 'S', long: ['split-string'] },
  }],
  ['nohup', { longFlags: ['help', 'version'] }],
  ['xargs', {
    letters: 'adEIJLnPRSs', attachedLetters: 'eil', flags: '0oprtx',
    long: ['arg-file', 'delimiter', 'max-args', 'max-chars', 'max-lines', 'max-procs', 'process-slot-var'],
    longFlags: ['null', 'eof', 'replace', 'open-tty', 'interactive', 'no-run-if-empty', 'show-limits', 'verbose', 'exit', 'help', 'version'],
  }],
  ['timeout', {
    letters: 'ks', flags: 'fpv', long: ['kill-after', 'signal'], longFlags: ['foreground', 'preserve-status', 'verbose', 'help', 'version'],
    before: 1, noProgramWords: ['/t', '/nobreak'],
  }],
  ['nice', { letters: 'n', attachedLetters: '0123456789', long: ['adjustment'], longFlags: ['help', 'version'] }],
  ['stdbuf', { letters: 'ioe', long: ['input', 'output', 'error'], longFlags: ['help', 'version'] }],
  ['setsid', { flags: 'cfwhV', longFlags: ['ctty', 'fork', 'wait', 'help', 'version'] }],
  ['chroot', { letters: 'Ggu', flags: 'n', long: ['groups', 'userspec'], longFlags: ['skip-chdir', 'help', 'version'], before: 1 }],
  ['sudo', {
    letters: 'aCcDghpRrTtUu', flags: 'ABbEeHiKklNnPSsVv',
    long: ['auth-type', 'chdir', 'chroot', 'close-from', 'command-timeout', 'group', 'host', 'login-class', 'other-user', 'prompt', 'role', 'type', 'user'],
    longFlags: [
      'askpass', 'bell', 'background', 'preserve-env', 'edit', 'set-home', 'help', 'login', 'remove-timestamp', 'reset-timestamp', 'list',
      'no-update', 'non-interactive', 'preserve-groups', 'stdin', 'shell', 'version', 'validate', 'new-window', 'disable-input', 'inline',
    ],
    assignments: true,
  }],
  ['doas', { letters: 'au', flags: 'ns', noProgram: 'CL' }],
  ['pkexec', { long: ['user'], longFlags: ['keep-cwd', 'disable-internal-agent', 'help', 'version'] }],
  ['busybox', { noProgramWords: ['--list', '--list-full', '--install', '--show', '--help'] }],
  ['wsl', { letters: 'du', flags: 'e', long: ['cd', 'distribution', 'distribution-id', 'user', 'shell-type'], longFlags: ['exec', 'system'] }],
]);

/** The POSIX shells' own commands that start a program */
const POSIX_SHELL_COMMANDS = new Map<string, PosixWrapper>([
  ['exec', { letters: 'a', flags: 'cl' }],
  ['command', { flags: 'p', noProgram: 'vV' }],
]);

/** cmd's start switches that take the next word as their value (/D also takes it in the same word: /Dpath) */
const CMD_START_VALUE_SWITCHES = ['/d', '/node', '/affinity', '/machine'];

/** A program a wrapper starts: its words as the shell reads them and as written, the name first */
type Started = Pick<FoundCommand, 'words' | 'written'>;

/**
 * The commands that run: each of `commands`, followed by the programs that
 * the wrappers among them start (for env sudo ls: env, then sudo). A started
 * program has its wrapper's start.
 */
export function withStartedPrograms(commands: FoundCommand[], shellType: ShellType): FoundCommand[] {
  const running: FoundCommand[] = [];
  const add = (command: FoundCommand): void => {
    running.push(command);
    if (command.nameAtRunTime) return;
    for (const { words, written } of startedPrograms(command, shellType)) {
      add({ name: words[0] ?? written[0], words, written, start: command.start, nameAtRunTime: words[0] === null });
    }
  };
  commands.forEach(add);
  return running;
}

/** The programs a command starts when it is a wrapper: none for any other command */
function startedPrograms(command: FoundCommand, shellType: ShellType): Started[] {
  const name = programName(command.name);
  const { words, written } = command;
  const from = (at: number): Started => ({ words: words.slice(at), written: written.slice(at) });
  const posix = PROGRAMS.get(name) ?? (shellType === 'posix' ? POSIX_SHELL_COMMANDS.get(name) : undefined);
  if (posix) return posixPrograms(command, posix);
  // Its own arguments are in -ArgumentList, a text the check doesn't read, so a program Start-Process starts has only its name
  if (shellType === 'powershell' && name === 'start-process') return (command.filePaths ?? []).map(({ word, written }) => ({ words: [word], written: [written] }));
  if (shellType === 'cmd' && name === 'start') return cmdStartProgramsAt(command).map(from);
  return [];
}

/**
 * The programs a POSIX wrapper starts: its words from each place the program
 * can be. env -S puts the words of its text in its own place and reads them as
 * env's words, followed by the words after the text (env -S ls sudo runs ls).
 */
function posixPrograms({ words, written }: Started, rules: PosixWrapper): Started[] {
  // Windows' timeout /t 5 only waits, and GNU's timeout stops with an error at /t, which is no duration
  const first = words[1];
  if (first && rules.noProgramWords?.includes(first.toLowerCase())) return [];
  const { operands, texts } = readOptions(words, rules);
  const at = new Set<number>();
  for (let i of operands) {
    // After the options: the NAME=VALUE settings, then the words before the program
    while (rules.assignments && i < words.length && (words[i] ?? written[i]).includes('=')) i++;
    i += rules.before ?? 0;
    if (i < words.length) at.add(i);
  }
  const programs = [...at].map((i) => ({ words: words.slice(i), written: written.slice(i) }));
  // A wrapper's command text is more of its own words, split as env splits -S's: env is the one wrapper with one
  return [...programs, ...texts.flatMap(({ text, after }) => {
    const split = envSplitWords(text);
    return posixPrograms({
      words: [words[0], ...split.words, ...words.slice(after)],
      written: [written[0], ...split.written, ...written.slice(after)],
    }, rules);
  })];
}

/** Where a program's options end, in each way they can be read, and the command texts they give */
interface OptionReadings {
  /** The first word after the options, in each reading */
  operands: number[];
  /** Each command text an option gives, and the first word after it */
  texts: { text: string; after: number }[];
}

/**
 * Reads a program's options by its rules, in every way they can be read: an
 * option the rules don't list, and a word known only at run time, may take the
 * next word as its value or not. A command text known only at run time (env
 * -S "$CMD") is read on as a word known only at run time.
 */
function readOptions(words: (string | null)[], rules: PosixWrapper): OptionReadings {
  const readings: OptionReadings = { operands: [], texts: [] };
  const read = new Set<number>();
  const readFrom = (i: number): void => {
    if (read.has(i)) return;
    read.add(i);
    const word = words[i];
    if (word === null) {
      // An option with or without a value, or the first word after them
      readings.operands.push(i);
      readFrom(i + 1);
      readFrom(i + 2);
      return;
    }
    if (word === undefined || !word.startsWith('-')) {
      readings.operands.push(i);
      return;
    }
    if (word === '--') {
      readings.operands.push(i + 1);
      return;
    }
    for (const reading of optionReadings(word, rules)) {
      if (reading === null) continue;
      if (reading.text === undefined) {
        readFrom(i + 1 + reading.next);
        continue;
      }
      const text = reading.next === 1 ? words[i + 1] : reading.text;
      if (text === null) readFrom(i + 1);
      else if (text !== undefined) readings.texts.push({ text, after: i + 1 + reading.next });
    }
  };
  readFrom(1);
  return readings;
}

/** One way to read an option word */
interface OptionReading {
  /** How many of the next words are its value: 0 or 1 */
  next: 0 | 1;
  /** For an option whose value is a command text: the text in the same word, or '' when it is the next word */
  text?: string;
}

/**
 * The ways to read an option word, null for one with which no program runs.
 * An option that takes a value takes the rest of the word (-uroot,
 * --user=root), or the next word when the rest is empty. One the rules don't
 * list may take a value or not, so it has both readings. A lone - is an
 * option too: env's -i.
 */
function optionReadings(option: string, rules: PosixWrapper): (OptionReading | null)[] {
  if (option.startsWith('--')) {
    const equals = option.indexOf('=');
    const name = longOption(option.slice(2, equals === -1 ? undefined : equals), rules);
    const isText = name !== undefined && rules.texts?.long.includes(name);
    if (equals !== -1) return [isText ? { next: 0, text: option.slice(equals + 1) } : { next: 0 }];
    if (name === undefined) return [{ next: 0 }, { next: 1 }];
    if (isText) return [{ next: 1, text: '' }];
    return [{ next: rules.long?.includes(name) ? 1 : 0 }];
  }
  const readings: (OptionReading | null)[] = [];
  for (let i = 1; i < option.length; i++) {
    const letter = option[i];
    const value: OptionReading = i === option.length - 1 ? { next: 1 } : { next: 0 };
    if (rules.noProgram?.includes(letter)) return [...readings, null];
    if (rules.texts?.letters.includes(letter)) return [...readings, { ...value, text: option.slice(i + 1) }];
    if (rules.attachedLetters?.includes(letter)) return [...readings, { next: 0 }];
    if (rules.letters?.includes(letter)) return [...readings, value];
    // An option the rules don't list may take a value, and the next letters read on as if it takes none
    if (!rules.flags?.includes(letter)) readings.push(value);
  }
  return [...readings, { next: 0 }];
}

/** The long option a name means: the one it names, or the only one it shortens */
function longOption(name: string, rules: PosixWrapper): string | undefined {
  const long = [...rules.long ?? [], ...rules.longFlags ?? [], ...rules.texts?.long ?? []];
  if (long.includes(name)) return name;
  const shortened = long.filter((known) => known.startsWith(name));
  return shortened.length === 1 ? shortened[0] : undefined;
}

/** What a backslash escape in env -S's text gives, besides the character after the backslash */
const ENV_ESCAPES: Record<string, string> = { f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', _: ' ' };

/**
 * The words env makes of -S's text, as GNU's and BSD's env split it: spaces,
 * tabs and \_ between words; '…' and "…" keep a word together, and in '…'
 * only \\ and \' are escapes; a backslash escape gives its character (\t a
 * tab, \_ a space inside "…"), and \c ends the text; a # that starts a word
 * starts a comment; and env fills in ${NAME} at run time, so its word is known
 * only then. Where env would stop with an error, nothing runs, so the text is
 * read as well as it can be.
 */
function envSplitWords(text: string): Started {
  const split: Started = { words: [], written: [] };
  // The word being read: undefined between words, null when known only at run time
  let word: string | null | undefined;
  let start = 0;
  let quote = '';
  const add = (chars: string | null, at: number): void => {
    if (word === undefined) {
      word = '';
      start = at;
    }
    word = word === null || chars === null ? null : word + chars;
  };
  const end = (at: number): void => {
    if (word === undefined) return;
    split.words.push(word);
    split.written.push(text.slice(start, at));
    word = undefined;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote === "'") {
      if (char === "'") quote = '';
      else if (char === '\\' && (text[i + 1] === '\\' || text[i + 1] === "'")) add(text[++i], i - 1);
      else add(char, i);
      continue;
    }
    if (char === '\\') {
      const escaped = text[++i];
      if (escaped === undefined || escaped === 'c') {
        end(i - 1);
        return split;
      }
      if (escaped === '_' && !quote) end(i - 1);
      else add(ENV_ESCAPES[escaped] ?? escaped, i - 1);
      continue;
    }
    if (char === quote) {
      quote = '';
      continue;
    }
    if (!quote && (char === '"' || char === "'")) {
      quote = char;
      add('', i);
      continue;
    }
    const close = char === '$' && text[i + 1] === '{' ? text.indexOf('}', i) : -1;
    if (close !== -1) {
      add(null, i);
      i = close;
      continue;
    }
    if (!quote && ' \t\n\v\f\r'.includes(char)) {
      end(i);
      continue;
    }
    // A comment, to the end of the text
    if (!quote && char === '#' && word === undefined) break;
    add(char, i);
  }
  end(text.length);
  return split;
}

/**
 * Where the program cmd's start starts can be: after its switches and its
 * window title, the first word in quotes. A word with %VAR% in it may be a
 * switch or the program: it counts, and so does the next word.
 */
function cmdStartProgramsAt({ words, written }: FoundCommand): number[] {
  const at: number[] = [];
  let title = false;
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (!title && written[i].startsWith('"')) {
      title = true;
      continue;
    }
    if (word?.startsWith('/')) {
      if (CMD_START_VALUE_SWITCHES.includes(word.toLowerCase())) i++;
      continue;
    }
    at.push(i);
    if (word !== null) break;
  }
  return at;
}
