import { parse, forEachChild, type SyntaxNode, type Word, type WordPart } from 'unbash';
import { braceWords, quotedChars, unquotedChars, MAX_BRACE_WORDS, type WordChar } from './brace-expansion.js';
import type { CommandReading, DefinedFunction, FoundCommand } from './command-reading.js';

/**
 * The command check's reader for POSIX shells (bash, zsh, sh, dash, ksh,
 * fish), with unbash, a bash parser. It finds every command the shell would
 * run, also on later lines and inside $( ), backticks, <( ), { } groups,
 * subshells, functions and if, while, for and case bodies. Words inside
 * quotes and heredoc bodies are text. A command name with a {a,b} brace
 * expansion is the first word it expands to, so {sudo,ls} is sudo, and so is
 * {$X,sudo} when $X is empty. zsh and
 * the other shells are read as bash, which covers the commands they have in
 * common.
 *
 * unbash doesn't stop at a syntax error: it returns what it could read and
 * lists the errors, each on the script it found it in ($( ) and backticks
 * are scripts of their own). Any error anywhere is a parse error here, so the
 * check never decides on a command it read only in part.
 */

/** Quoted and literal text is known before execution; globs depend on the matching files */
const STATIC_PARTS = new Set(['Literal', 'SingleQuoted', 'AnsiCQuoted']);

/** Word parts that bash drops when they are empty and unquoted ($X, ${X}, $(cmd)) */
const VANISHING_PARTS = new Set(['SimpleExpansion', 'ParameterExpansion', 'CommandExpansion']);

/** The commands that remove a function: unset -f, and zsh's unfunction, unhash -f and disable -f */
const FUNCTION_REMOVERS = new Set(['unset', 'unfunction', 'unhash', 'disable']);

/**
 * Stand-ins for a piece known only at run time in a brace word's characters,
 * so that braceWords keeps the words next to it ({$X,sudo} makes $X and sudo):
 * one for a piece in VANISHING_PARTS, one for any other ("$X"). They start
 * with a NUL, which no command text holds: Node starts no command that has one.
 */
const DROPPED_IF_EMPTY = '\0$';
const KEPT_IF_EMPTY = '\0"';

/**
 * A word that brace expansion made and bash may drop: only pieces it drops
 * when they are empty, and letters, digits or _ after one, which bash may read
 * into a $X's name ({$X,su}do makes $Xdo)
 */
const MAY_VANISH = /^(?:\0\$\w*)+$/;

/**
 * The commands that run, in this shell, code the reader doesn't read: eval and
 * zsh's emulate -c (their words), trap and mapfile or readarray -C (later), .
 * and source (a file), and alias (its value, where the name is used: an alias
 * comes before a function)
 */
const CODE_RUNNERS = new Set(['eval', 'emulate', 'trap', 'mapfile', 'readarray', '.', 'source', 'alias']);

/** The words that run the next word as a command in this shell: builtin, command, and zsh's noglob and nocorrect */
const COMMAND_PREFIXES = new Set(['builtin', 'command', 'noglob', 'nocorrect']);

/**
 * A word's value as bash reads it (quotes and escapes removed, $'…' decoded),
 * or null when part of it is known only at run time: an expansion, a command's
 * output, or a {a,b} brace expansion, which makes several words (the reader
 * expands a command name's braces with braceWords).
 */
function wordValue(word: Word): string | null {
  return (word.parts ?? []).every((part) => partValue(part) !== null) ? word.value : null;
}

/** One part's value as bash reads it, or null when it is known only at run time */
function partValue(part: WordPart): string | null {
  if (part.type === 'DoubleQuoted' || part.type === 'LocaleString') {
    if (!part.parts.every((inner) => inner.type === 'Literal')) return null;
    return part.parts.map((inner) => (inner.type === 'Literal' ? inner.value : '')).join('');
  }
  return STATIC_PARTS.has(part.type) && 'value' in part ? part.value : null;
}

/**
 * A word's characters for brace expansion. Only the braces unbash reads as an
 * expansion are syntax. The rest of the word is text, and so are the quoted
 * pieces inside the braces: {"a,b",c} gives a,b and c.
 */
function braceChars(word: Word): WordChar[] {
  const chars: WordChar[] = [];
  for (const part of word.parts ?? []) {
    if (part.type !== 'BraceExpansion') {
      chars.push(...partChars(part));
      continue;
    }
    // The braces' text as written, except the quoted or expanded pieces inside, which are parts of their own
    let at = part.pos;
    for (const inner of part.parts ?? []) {
      chars.push(...unquotedChars(part.text.slice(at - part.pos, inner.pos - part.pos)));
      chars.push(...(inner.type === 'Literal' ? unquotedChars(inner.text) : partChars(inner)));
      at = inner.end;
    }
    chars.push(...unquotedChars(part.text.slice(at - part.pos)));
  }
  return chars;
}

/** A part's characters, all text: its value, or a stand-in when it is known only at run time */
function partChars(part: WordPart): WordChar[] {
  const value = partValue(part);
  if (value !== null) return quotedChars(value);
  return quotedChars(VANISHING_PARTS.has(part.type) ? DROPPED_IF_EMPTY : KEPT_IF_EMPTY);
}

/**
 * The words bash makes from a word, each with its value (null when it is known
 * only at run time) and whether bash may drop it, or null past braceWords' limits.
 * A brace expansion makes several and bash drops the empty ones: {,sudo} ls
 * runs sudo, {,} sudo runs sudo, and {$X,sudo} id runs sudo when $X is empty.
 */
function wordsMade(word: Word): { value: string | null; mayVanish: boolean }[] | null {
  if (!word.parts?.some((part) => part.type === 'BraceExpansion')) {
    return [{ value: wordValue(word), mayVanish: mayVanish(word) }];
  }
  const made = braceWords(braceChars(word));
  return made && made.map((text) => ({ value: text.includes('\0') ? null : text, mayVanish: MAY_VANISH.test(text) }));
}

type ExpandedWord = { value: string | null; mayVanish: boolean; source: Word };

/** Keep every argument expansion aligned with its source, so wrappers see the words the shell passes */
function commandWords(words: Word[]): ExpandedWord[] | null {
  const expanded: ExpandedWord[] = [];
  for (const source of words) {
    const made = wordsMade(source);
    if (made === null) return null;
    expanded.push(...made.map((word) => ({ ...word, source })));
  }
  return expanded;
}

/** Whether bash may drop the word entirely, so that the next word is the command's name */
function mayVanish(word: Word): boolean {
  const parts = word.parts ?? [];
  return parts.length > 0 && parts.every((part) => VANISHING_PARTS.has(part.type));
}

/**
 * Whether a command may remove the function `name`: one of FUNCTION_REMOVERS
 * anywhere among the command's words (so also after builtin, command or
 * eval), followed by the name or by a word known only at run time
 */
function mayRemoveFunction(command: FoundCommand, name: string): boolean {
  const at = command.words.findIndex((word) => word !== null && FUNCTION_REMOVERS.has(word));
  return at >= 0 && command.words.slice(at + 1).some((word) => word === null || word === name);
}

/**
 * Whether a command may run code the reader doesn't read, which may remove any
 * function: one of CODE_RUNNERS, also after COMMAND_PREFIXES (command -p eval),
 * or a name known only at run time ($cmd may be unset or eval)
 */
function mayRunUnreadCode(command: FoundCommand): boolean {
  const { words } = command;
  let at = 0;
  while (COMMAND_PREFIXES.has(words[at] ?? '')) {
    at++;
    while (words[at]?.startsWith('-')) at++;
  }
  const name = words[at];
  return name === null || (name !== undefined && CODE_RUNNERS.has(name));
}

/** Reads a command for a POSIX shell */
export async function readPosixCommands(command: string): Promise<CommandReading> {
  const script = parse(command);
  let parseError: string | undefined;
  const commands: FoundCommand[] = [];

  // Positions inside backticks count from the backticks' own text, so a command
  // there is given the start of the backticks around it
  const visit = (node: SyntaxNode, backticksStart: number | undefined): void => {
    if (node.type === 'Script') parseError ??= node.errors?.[0]?.message;
    if (node.type === 'Command' && node.name) {
      const words = [node.name, ...node.args.filter((arg): arg is Word => arg.type === 'Word')];
      const expanded = commandWords(words);
      if (expanded === null) {
        parseError ??= `brace expansion makes more than ${MAX_BRACE_WORDS} words, or takes too long to read`;
      } else {
        // An unquoted runtime word may vanish, exposing the next word as the executable.
        const runtimeSources = new Set<Word>();
        for (let i = 0; i < expanded.length; i++) {
          const name = expanded[i];
          if (name.value === null && runtimeSources.has(name.source)) {
            if (!name.mayVanish) break;
            continue;
          }
          if (name.value === null) runtimeSources.add(name.source);
          const remaining = expanded.slice(i);
          commands.push({
            name: name.value ?? name.source.text,
            words: remaining.map((word) => word.value),
            written: remaining.map((word) => word.source.text),
            wordTexts: remaining.map((word) => word.value ?? word.source.value),
            start: backticksStart ?? (name.source === words[0] ? node.pos : name.source.pos),
            nameAtRunTime: name.value === null,
          });
          if (!name.mayVanish) break;
        }
      }
    }
    const inBackticks = node.type === 'CommandExpansion' && node.text.startsWith('`');
    const childBackticksStart = inBackticks ? backticksStart ?? node.pos : backticksStart;
    forEachChild(node, (child) => visit(child, childBackticksStart));
  };
  visit(script, undefined);

  if (parseError !== undefined) return { commands: [], functions: [], parseError };

  // Only the script's own statements (see CommandReading.functions), and none the
  // text may remove: wherever the removal is written, it may run before a call,
  // from a function's body. Code the reader doesn't read may remove any of them.
  const functions: DefinedFunction[] = [];
  const statements = commands.some(mayRunUnreadCode) ? [] : script.commands;
  for (const statement of statements) {
    if (statement.command.type !== 'Function' || statement.background) continue;
    const name = statement.command.name.value;
    if (!commands.some((command) => mayRemoveFunction(command, name))) {
      functions.push({ name, end: statement.command.end });
    }
  }
  return { commands: commands.sort((a, b) => a.start - b.start), functions };
}
