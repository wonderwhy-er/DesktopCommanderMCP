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
 *   program after them from every shell;
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
}

/** The wrappers that are programs, with their options in GNU, BSD and macOS (and Windows' sudo) */
const PROGRAMS = new Map<string, PosixWrapper>([
  ['env', { letters: 'uCSPLUa', long: ['unset', 'chdir', 'split-string', 'argv0'], assignments: true }],
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
  if (posix) return posixProgramsAt(command, posix).map(from);
  // Its own arguments are in -ArgumentList, a text the check doesn't read, so a program Start-Process starts has only its name
  if (shellType === 'powershell' && name === 'start-process') return (command.filePaths ?? []).map(({ word, written }) => ({ words: [word], written: [written] }));
  if (shellType === 'cmd' && name === 'start') return cmdStartProgramsAt(command).map(from);
  return [];
}

/** Where the program a POSIX wrapper starts can be: indexes into its words */
function posixProgramsAt({ words, written }: FoundCommand, rules: PosixWrapper): number[] {
  const at: number[] = [];
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
    if (valueWords === undefined) return at;
    i += valueWords;
  }
  afterOptions(i);
  return [...new Set(at)];
}

/**
 * How many of the next words an option takes as its value: 0 or 1, or
 * undefined when with it no program runs. A lone - is an option too: env's
 * -i. An option the rules don't list takes no value.
 */
function optionValueWords(option: string, rules: PosixWrapper): 0 | 1 | undefined {
  if (option.startsWith('--')) {
    if (option.includes('=')) return 0;
    const name = option.slice(2);
    const long = rules.long ?? [];
    return long.includes(name) || long.filter((known) => known.startsWith(name)).length === 1 ? 1 : 0;
  }
  for (let i = 1; i < option.length; i++) {
    const letter = option[i];
    if (rules.noProgram?.includes(letter)) return undefined;
    // The rest of the word is the value of an option that takes one
    if (rules.attachedLetters?.includes(letter)) return 0;
    if (rules.letters?.includes(letter)) return i === option.length - 1 ? 1 : 0;
  }
  return 0;
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
