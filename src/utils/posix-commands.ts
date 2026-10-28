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

/** Word parts whose text is taken as written (a glob as its own text, not the files it matches) */
const STATIC_PARTS = new Set(['Literal', 'SingleQuoted', 'AnsiCQuoted', 'Glob']);

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
 * only at run time) and whether bash may drop it, or null past MAX_BRACE_WORDS.
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
      const values = words.map(wordValue);
      // The name, and the next word too while the words before it may vanish ($EMPTY sudo ls runs sudo)
      for (let i = 0; i < words.length; i++) {
        const made = wordsMade(words[i]);
        if (made === null) {
          parseError ??= `brace expansion makes more than ${MAX_BRACE_WORDS} words`;
          break;
        }
        // Each word made is the name while the ones before it may vanish; those known only at run time all
        // give the word's text as the name, so it is given once
        const kept = made.findIndex((word) => !word.mayVanish);
        const names = kept < 0 ? made : made.slice(0, kept + 1);
        names.forEach((name, k) => {
          if (name.value === null && names.findIndex((other) => other.value === null) < k) return;
          commands.push({
            name: name.value ?? words[i].text,
            words: [...made.slice(k).map((word) => word.value), ...values.slice(i + 1)],
            start: backticksStart ?? (i === 0 ? node.pos : words[i].pos),
            nameAtRunTime: name.value === null,
          });
        });
        if (kept >= 0) break;
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
  // from a function's body
  const functions: DefinedFunction[] = [];
  for (const statement of script.commands) {
    if (statement.command.type !== 'Function' || statement.background) continue;
    const name = statement.command.name.value;
    if (!commands.some((command) => mayRemoveFunction(command, name))) {
      functions.push({ name, end: statement.command.end });
    }
  }
  return { commands: commands.sort((a, b) => a.start - b.start), functions };
}
