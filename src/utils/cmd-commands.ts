import type { CommandReading, FoundCommand } from './command-reading.js';

/**
 * The command check's reader for cmd. There is no parser for cmd to use, so
 * this is a small one that follows cmd's own rules for a command line:
 * - a command ends at &, &&, ||, | and a line break outside "…";
 * - inside "…" everything is text; ' is an ordinary character;
 * - ^ makes the next character ordinary text;
 * - ( … ) at the start of a command is a group of commands;
 * - > and < with their target (2>&1, >>log.txt) are redirections, not words;
 * - a leading @ is dropped (@echo off runs echo);
 * - a word with %VAR% in it is known only at run time;
 * - if and for run the command after their condition or after "do";
 * - call runs the command after it (call :label runs a label of a batch file,
 *   which no blockedCommands entry names).
 * cmd has no functions, so none are listed.
 */

interface Token {
  /** word: a word; op: & && || | or a line break; open/close: ( and ); redirect: > >> < with a handle */
  kind: 'word' | 'op' | 'open' | 'close' | 'redirect';
  /** The word as cmd reads it: quotes and ^ removed */
  value: string;
  /** The word as written, quotes and ^ included */
  text: string;
  start: number;
  /** True when the word has %VAR% in it, so its value is known only at run time */
  atRunTime: boolean;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === ' ' || char === '\t') {
      i++;
    } else if (char === '\r' || char === '\n') {
      tokens.push({ kind: 'op', value: '\n', text: char, start: i, atRunTime: false });
      i++;
    } else if (char === '&' || char === '|') {
      const value = text[i + 1] === char ? char + char : char;
      tokens.push({ kind: 'op', value, text: value, start: i, atRunTime: false });
      i += value.length;
    } else if (char === '(' || char === ')') {
      tokens.push({ kind: char === '(' ? 'open' : 'close', value: char, text: char, start: i, atRunTime: false });
      i++;
    } else if (char === '>' || char === '<' || (/[0-9]/.test(char) && /[<>]/.test(text[i + 1] ?? ''))) {
      // A redirection: an optional handle number, > >> or <, and &N when it points at another handle
      const start = i;
      if (/[0-9]/.test(char)) i++;
      i += text[i] === '>' && text[i + 1] === '>' ? 2 : 1;
      if (text[i] === '&' && /[0-9]/.test(text[i + 1] ?? '')) i += 2;
      tokens.push({ kind: 'redirect', value: text.slice(start, i), text: text.slice(start, i), start, atRunTime: false });
    } else {
      const start = i;
      let value = '';
      let inQuotes = false;
      while (i < text.length) {
        const c = text[i];
        if (inQuotes) {
          if (c === '"') inQuotes = false;
          else if (c === '\r' || c === '\n') break;
          else value += c;
          i++;
        } else if (c === '"') {
          inQuotes = true;
          i++;
        } else if (c === '^' && i + 1 < text.length) {
          value += text[i + 1];
          i += 2;
        } else if (' \t\r\n&|()<>'.includes(c)) {
          break;
        } else {
          value += c;
          i++;
        }
      }
      tokens.push({ kind: 'word', value, text: text.slice(start, i), start, atRunTime: /%[^%\s]+%/.test(text.slice(start, i)) });
    }
  }
  return tokens;
}

const IF_TESTS = ['exist', 'defined', 'errorlevel', 'cmdextversion'];
const IF_COMPARISONS = ['equ', 'neq', 'lss', 'leq', 'gtr', 'geq'];

/**
 * How many words an if condition starting at words[i] takes: "exist x" and
 * the other tests take 2, "a==b" 1, "a== b" and "a ==b" 2, "a == b" and
 * "a equ b" 3. Undefined while the words so far aren't a condition yet.
 */
function ifConditionLength(words: Token[], i: number): number | undefined {
  const word = words[i]?.value;
  if (word === undefined) return undefined;
  const next = words[i + 1]?.value;
  if (IF_TESTS.includes(word.toLowerCase())) return 2;
  if (/^.+==.+$/.test(word)) return 1;
  if (word.endsWith('==')) return 2;
  if (next === '==') return 3;
  if (next?.startsWith('==')) return 2;
  if (next !== undefined && IF_COMPARISONS.includes(next.toLowerCase())) return 3;
  return undefined;
}

class CmdReader {
  private position = 0;
  readonly commands: FoundCommand[] = [];

  constructor(private readonly tokens: Token[]) {}

  /** Reads commands and the operators between them, up to the end, or up to the ) that closes a group */
  readList(inGroup: boolean): void {
    while (this.position < this.tokens.length) {
      const token = this.tokens[this.position];
      if (token.kind === 'op') {
        this.position++;
      } else if (token.kind === 'close' && inGroup) {
        return;
      } else {
        this.readCommand(inGroup);
      }
    }
    if (inGroup) throw new Error('a ( group is not closed with )');
  }

  /** Reads one command: a group, or words up to the next operator */
  private readCommand(inGroup: boolean): void {
    if (this.tokens[this.position].kind === 'open') {
      this.position++;
      this.readList(true);
      this.position++; // the closing )
      this.skipRedirects();
      return;
    }
    const words: Token[] = [];
    let parens = 0;
    while (this.position < this.tokens.length) {
      const token = this.tokens[this.position];
      if (token.kind === 'op') break;
      if (token.kind === 'close' && parens === 0 && inGroup) break;
      if (token.kind === 'redirect') {
        this.skipRedirects();
        continue;
      }
      // An if or for condition: the command after it starts here, and a ( there opens a group
      if (words.length > 0 && token.kind !== 'close' && this.startsCommandAfter(words, parens)) {
        this.readCommand(inGroup);
        return;
      }
      if (token.kind === 'open') parens++;
      if (token.kind === 'close') parens--;
      words.push(token);
      this.position++;
    }
    if (words.length > 0 && !this.startsCommandAfter(words, parens)) this.addCommand(words);
  }

  /**
   * Whether the words so far are a whole if condition, a for clause up to its
   * "do", an "else" or a "call", so the next token starts the command that runs.
   * parens: how many of the words' ( are not closed yet.
   */
  private startsCommandAfter(words: Token[], parens: number): boolean {
    const first = words[0].value.replace(/^@+/, '').toLowerCase();
    if (first === 'else' || first === 'call') return words.length === 1;
    if (first === 'for') {
      return words.length > 1 && parens === 0 && words[words.length - 1].value.toLowerCase() === 'do';
    }
    if (first !== 'if') return false;
    let i = 1;
    while (i < words.length && ['/i', 'not'].includes(words[i].value.toLowerCase())) i++;
    const length = ifConditionLength(words, i);
    return length !== undefined && words.length === i + length;
  }

  private skipRedirects(): void {
    while (this.tokens[this.position]?.kind === 'redirect') {
      const redirect = this.tokens[this.position++];
      if (!/&[0-9]$/.test(redirect.value) && this.tokens[this.position]?.kind === 'word') this.position++;
    }
  }

  private addCommand(words: Token[]): void {
    const first = words[0];
    const name = first.value.replace(/^@+/, '');
    if (!name && words.length === 1) return; // a lone @
    this.commands.push({
      name,
      words: words.map((word, index) => (word.atRunTime ? null : index === 0 ? name : word.value)),
      written: words.map((word) => word.text),
      wordTexts: words.map((word, index) => (index === 0 ? name : word.value)),
      start: first.start,
      nameAtRunTime: first.atRunTime,
    });
  }
}

/** Reads a command for cmd */
export async function readCmdCommands(command: string): Promise<CommandReading> {
  const reader = new CmdReader(tokenize(command));
  try {
    reader.readList(false);
  } catch (error) {
    return { commands: [], functions: [], parseError: error instanceof Error ? error.message : String(error) };
  }
  return { commands: reader.commands.sort((a, b) => a.start - b.start), functions: [] };
}
