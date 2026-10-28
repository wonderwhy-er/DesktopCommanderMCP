import { parse, forEachChild, type SyntaxNode, type Word, type WordPart } from 'unbash';
import { braceWords, quotedChars, unquotedChars, MAX_BRACE_WORDS, type WordChar } from './brace-expansion.js';
import type { CommandReading, FoundCommand } from './command-reading.js';

/**
 * The command check's reader for POSIX shells (bash, zsh, sh, dash, ksh,
 * fish), with unbash, a bash parser. It finds every command the shell would
 * run, also on later lines and inside $( ), backticks, <( ), { } groups,
 * subshells, functions and if, while, for and case bodies. Words inside
 * quotes and heredoc bodies are text. A command name with a {a,b} brace
 * expansion is the first word it expands to, so {sudo,ls} is sudo. zsh and
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
 * A word's characters for brace expansion, or null when part of it is known
 * only at run time ({$X,ls}). Only the braces unbash reads as an expansion are
 * syntax. The rest of the word is text, and so are the quoted pieces inside
 * the braces: {"a,b",c} gives a,b and c.
 */
function braceChars(word: Word): WordChar[] | null {
  const chars: WordChar[] = [];
  for (const part of word.parts ?? []) {
    if (part.type !== 'BraceExpansion') {
      const value = partValue(part);
      if (value === null) return null;
      chars.push(...quotedChars(value));
      continue;
    }
    // The braces' text as written, except the quoted or expanded pieces inside, which are parts of their own
    let at = part.pos;
    for (const inner of part.parts ?? []) {
      chars.push(...unquotedChars(part.text.slice(at - part.pos, inner.pos - part.pos)));
      if (inner.type === 'Literal') {
        chars.push(...unquotedChars(inner.text));
      } else {
        const value = partValue(inner);
        if (value === null) return null;
        chars.push(...quotedChars(value));
      }
      at = inner.end;
    }
    chars.push(...unquotedChars(part.text.slice(at - part.pos)));
  }
  return chars;
}

/** Whether bash may drop the word entirely, so that the next word is the command's name */
function mayVanish(word: Word): boolean {
  const parts = word.parts ?? [];
  return parts.length > 0 && parts.every((part) => VANISHING_PARTS.has(part.type));
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
        const braced = words[i].parts?.some((part) => part.type === 'BraceExpansion') ? braceChars(words[i]) : null;
        // bash expands the name's braces before it runs it and drops the empty words: {,sudo} ls runs sudo, {,} sudo runs sudo
        const expanded: (string | null)[] | null = braced ? braceWords(braced) : [values[i]];
        if (expanded === null) {
          parseError ??= `brace expansion makes more than ${MAX_BRACE_WORDS} words`;
          break;
        }
        if (expanded.length === 0) continue;
        const nameAtRunTime = expanded[0] === null;
        commands.push({
          name: nameAtRunTime ? words[i].text : expanded[0] as string,
          words: [...expanded, ...values.slice(i + 1)],
          start: backticksStart ?? (i === 0 ? node.pos : words[i].pos),
          nameAtRunTime,
        });
        if (!mayVanish(words[i])) break;
      }
    }
    const inBackticks = node.type === 'CommandExpansion' && node.text.startsWith('`');
    const childBackticksStart = inBackticks ? backticksStart ?? node.pos : backticksStart;
    forEachChild(node, (child) => visit(child, childBackticksStart));
  };
  visit(script, undefined);

  if (parseError !== undefined) return { commands: [], parseError };
  return { commands: commands.sort((a, b) => a.start - b.start) };
}
