import { parse, forEachChild, type SyntaxNode, type Word } from 'unbash';
import type { CommandReading, DefinedFunction, FoundCommand } from './command-reading.js';

/**
 * The command check's reader for POSIX shells (bash, zsh, sh, dash, ksh,
 * fish), with unbash, a bash parser. It finds every command the shell would
 * run, also on later lines and inside $( ), backticks, <( ), { } groups,
 * subshells, functions and if, while, for and case bodies. Words inside
 * quotes and heredoc bodies are text. zsh and the other shells are read as
 * bash, which covers the commands they have in common.
 *
 * unbash doesn't stop at a syntax error: it returns what it could read and
 * lists the errors, each on the script it found it in ($( ) and backticks
 * are scripts of their own). Any error anywhere is a parse error here, so the
 * check never decides on a command it read only in part.
 */

/** Word parts whose text is known before the command runs */
const STATIC_PARTS = new Set(['Literal', 'SingleQuoted', 'AnsiCQuoted', 'Glob']);

/** Word parts that bash drops when they are empty and unquoted ($X, ${X}, $(cmd)) */
const VANISHING_PARTS = new Set(['SimpleExpansion', 'ParameterExpansion', 'CommandExpansion']);

/**
 * A word's value as bash reads it (quotes and escapes removed, $'…' decoded),
 * or null when part of it is known only at run time: an expansion, a command's
 * output, or a {a,b} brace expansion, which this reader doesn't expand.
 */
function wordValue(word: Word): string | null {
  for (const part of word.parts ?? []) {
    if (part.type === 'DoubleQuoted' || part.type === 'LocaleString') {
      if (!part.parts.every((inner) => inner.type === 'Literal')) return null;
    } else if (!STATIC_PARTS.has(part.type)) {
      return null;
    }
  }
  return word.value;
}

/** Whether bash may drop the word entirely, so that the next word is the command's name */
function mayVanish(word: Word): boolean {
  const parts = word.parts ?? [];
  return parts.length > 0 && parts.every((part) => VANISHING_PARTS.has(part.type));
}

/** Reads a command for a POSIX shell */
export async function readPosixCommands(command: string): Promise<CommandReading> {
  const script = parse(command);
  const errors: string[] = [];
  const commands: FoundCommand[] = [];

  // Positions inside backticks count from the backticks' own text, so a command
  // there is given the start of the backticks around it
  const visit = (node: SyntaxNode, backticksStart: number | undefined): void => {
    if (node.type === 'Script') {
      for (const error of node.errors ?? []) errors.push(error.message);
    }
    if (node.type === 'Command' && node.name) {
      const words = [node.name, ...node.args.filter((arg): arg is Word => arg.type === 'Word')];
      const values = words.map(wordValue);
      // The name, and the next word too while the words before it may vanish ($EMPTY sudo ls runs sudo)
      for (let i = 0; i < words.length; i++) {
        const nameAtRunTime = values[i] === null;
        commands.push({
          name: nameAtRunTime ? words[i].text : values[i] as string,
          words: values.slice(i),
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

  if (errors.length > 0) {
    return { commands: [], functions: [], parseError: errors[0] };
  }

  // Only the script's own statements: a definition inside a subshell, a function,
  // a pipeline, a body or after && or || may not exist when a later command runs
  const functions: DefinedFunction[] = [];
  for (const statement of script.commands) {
    if (statement.command.type === 'Function' && !statement.background) {
      functions.push({ name: statement.command.name.value, end: statement.command.end });
    }
  }
  return { commands: commands.sort((a, b) => a.start - b.start), functions };
}
