import { programName, type ShellType } from './shell.js';
import type { FoundCommand } from './command-reading.js';

/**
 * The command check's rules for wrappers: commands that start another
 * program, as env does in "env sudo ls", which runs sudo. checkCommand()
 * follows each wrapper to the program it starts, past the wrapper's own
 * options (timeout 5 reboot, nice -n 10 dd, sudo -u root id), and checks that
 * program like any other command. A wrapper can start another wrapper: env
 * nohup sudo ls runs sudo.
 * - env, nohup, xargs, timeout, nice and sudo are programs, so they start the
 *   program after them from every shell. env -S 'sudo ls' runs sudo too: env
 *   splits -S's text into more of its own words;
 * - exec and command are commands of the POSIX shells;
 * - Start-Process (also written start or saps) is PowerShell's: the PowerShell
 *   reader gives the programs it starts, as PowerShell itself binds its
 *   FilePath (FoundCommand's filePaths);
 * - start is cmd's (cmd's call is the cmd reader's, as if and else are).
 *
 * A word known only at run time where an option could be ($OPTS in nice
 * $OPTS make) may be the program or an option, so both readings count: it is
 * a program known only at run time, and the next word may be the program too.
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
  /** The one-letter options whose value can only be in the same word (xargs -i{}) */
  attachedLetters?: string;
  /** The long options that take a value */
  long?: string[];
  /** The options with which no program runs: command -v sudo only says what sudo is */
  noProgram?: string;
  /** How many words after the options come before the program: timeout's duration */
  before?: number;
  /** Whether NAME=VALUE words before the program set its environment (env, sudo) */
  assignments?: boolean;
  /** The option whose value is a text of more of the wrapper's words (env -S 'sudo ls', --split-string='sudo ls') */
  split?: { letter: string; long: string };
}

/** The wrappers that are programs, with their options in GNU, BSD and macOS (and Windows' sudo) */
const PROGRAMS = new Map<string, PosixWrapper>([
  ['env', { letters: 'uCSPLUa', long: ['unset', 'chdir', 'split-string', 'argv0'], assignments: true, split: { letter: 'S', long: 'split-string' } }],
  ['nohup', {}],
  ['xargs', { letters: 'adEIJLnPRSs', attachedLetters: 'eil', long: ['arg-file', 'delimiter', 'max-args', 'max-chars', 'max-procs', 'process-slot-var'] }],
  ['timeout', { letters: 'ks', long: ['kill-after', 'signal'], before: 1 }],
  ['nice', { letters: 'n', long: ['adjustment'] }],
  ['sudo', { letters: 'aCcDghpRrTtUu', long: ['auth-type', 'chdir', 'chroot', 'close-from', 'command-timeout', 'group', 'host', 'login-class', 'other-user', 'prompt', 'role', 'type', 'user'], assignments: true }],
]);

/** The POSIX shells' own commands that start a program */
const POSIX_SHELL_COMMANDS = new Map<string, PosixWrapper>([
  ['exec', { letters: 'a' }],
  ['command', { noProgram: 'vV' }],
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
  const at: number[] = [];
  const programs = (): Started[] => [...new Set(at)].map((i) => ({ words: words.slice(i), written: written.slice(i) }));
  // After the options: the NAME=VALUE settings, then the words before the program
  const afterOptions = (i: number): void => {
    while (rules.assignments && i < words.length && (words[i] ?? written[i]).includes('=')) i++;
    i += rules.before ?? 0;
    if (i < words.length) at.push(i);
  };
  let i = 1;
  for (; i < words.length; i++) {
    const word = words[i];
    if (word === null) {
      // An option, or the first word after them: both readings count
      afterOptions(i);
      continue;
    }
    if (word === '--') {
      i++;
      break;
    }
    if (!word.startsWith('-')) break;
    const valueWords = optionValueWords(word, rules);
    if (valueWords === undefined) return programs();
    const inWord = splitTextInWord(word, rules);
    if (inWord !== undefined) {
      const text = valueWords === 1 ? words[i + 1] : inWord;
      // A text known only at run time (env -S "$CMD"): the next round reads it as a word known only at run time
      if (text === null) continue;
      if (text === undefined) return programs();
      const after = i + 1 + valueWords;
      const split = envSplitWords(text);
      return [...programs(), ...posixPrograms({
        words: [words[0], ...split.words, ...words.slice(after)],
        written: [written[0], ...split.written, ...written.slice(after)],
      }, rules)];
    }
    i += valueWords;
  }
  afterOptions(i);
  return programs();
}

/**
 * How many of the next words an option takes as its value: 0 or 1, or
 * undefined when with it no program runs. A lone - is an option too: env's
 * -i. An option the rules don't list takes no value.
 */
function optionValueWords(option: string, rules: PosixWrapper): 0 | 1 | undefined {
  if (option.startsWith('--')) return !option.includes('=') && longOption(option.slice(2), rules) ? 1 : 0;
  for (let i = 1; i < option.length; i++) {
    const letter = option[i];
    if (rules.noProgram?.includes(letter)) return undefined;
    // The rest of the word is the value of an option that takes one
    if (rules.attachedLetters?.includes(letter)) return 0;
    if (rules.letters?.includes(letter)) return i === option.length - 1 ? 1 : 0;
  }
  return 0;
}

/** The long option that takes a value a name means: the one it names, or the only one it shortens */
function longOption(name: string, rules: PosixWrapper): string | undefined {
  const long = rules.long ?? [];
  if (long.includes(name)) return name;
  const shortened = long.filter((known) => known.startsWith(name));
  return shortened.length === 1 ? shortened[0] : undefined;
}

/**
 * When an option word is the rules' split option: the text in the same word
 * (-S'sudo ls', -iS'sudo ls', --split-string='sudo ls'), or '' when the text
 * is the next word. Undefined for any other option.
 */
function splitTextInWord(option: string, rules: PosixWrapper): string | undefined {
  if (!rules.split) return undefined;
  if (option.startsWith('--')) {
    const equals = option.indexOf('=');
    if (longOption(option.slice(2, equals === -1 ? undefined : equals), rules) !== rules.split.long) return undefined;
    return equals === -1 ? '' : option.slice(equals + 1);
  }
  // The first letter that takes a value takes the rest of the word
  for (let i = 1; i < option.length; i++) {
    if (option[i] === rules.split.letter) return option.slice(i + 1);
    if (rules.letters?.includes(option[i]) || rules.attachedLetters?.includes(option[i])) return undefined;
  }
  return undefined;
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
