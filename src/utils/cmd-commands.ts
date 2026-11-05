import type { CommandReading, FoundCommand } from './command-reading.js';

/**
 * The command check's reader for cmd. There is no parser for cmd to use, so
 * this is a small one that follows cmd's own rules for a command line:
 * - a command ends at &, &&, ||, | and a line break outside "…";
 * - inside "…" everything is text; ' is an ordinary character;
 * - ^ makes the next character ordinary text;
 * - ( … ) at the start of a command is a group of commands;
 * - > and < with their target (2>&1, >>log.txt) are redirections, not words;
 * - ; , = and @ before a command are skipped, as spaces are (@echo off runs
 *   echo, ;sc and @ sc run sc);
 * - a command's name ends at ; , = and / outside "…", also after ^ (net,user
 *   and sc/query run net and sc), but a name with a drive letter keeps its /
 *   (C:/Windows/System32/sc.exe);
 * - a word with %VAR% in it is known only at run time;
 * - if and for run the command after their condition or after "do";
 * - call runs the command after it (call :label runs a label of a batch file,
 *   which no blockedCommands entry names).
 * - for /f also runs its single-quoted set (back-quoted with usebackq).
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
  /** How many of a word's first characters are ; , = or @ as written: cmd skips them where a command starts */
  lead?: number;
  /** Where in value a command's name ends, at a ; , = or / outside "…"; undefined when the whole word is the name */
  nameEnd?: number;
  /** Where in text the name ends, as nameEnd in value */
  textEnd?: number;
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
      // Where in value a ; , = or / is outside "…": cmd ends a command's name at the first one
      const ends: { value: number; text: number }[] = [];
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
          if (';,=/'.includes(text[i + 1])) ends.push({ value: value.length, text: i - start });
          value += text[i + 1];
          i += 2;
        } else if (' \t\r\n&|()<>'.includes(c)) {
          break;
        } else {
          if (';,=/'.includes(c)) ends.push({ value: value.length, text: i - start });
          value += c;
          i++;
        }
      }
      const written = text.slice(start, i);
      const lead = /^[;,=@]*/.exec(written)![0].length;
      const drive = /^[A-Za-z]:/.test(value.slice(lead));
      const end = ends.find((at) => at.value >= lead && !(drive && value[at.value] === '/'));
      const atRunTime = /%[^%\s]+%/.test(written);
      const ending = { nameEnd: end?.value, textEnd: end?.text };
      tokens.push({ kind: 'word', value, text: written, start, atRunTime, lead, ...ending });
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

/** Whether a word is only ; , = and @, which cmd skips where a command starts */
const isLead = (word: Token): boolean => word.lead !== undefined && word.lead > 0 && word.lead === word.value.length;

/** The name a command's first word gives, without the ; , = and @ that cmd skips before it (;sc runs sc) */
const commandName = (word: Token): string => word.value.slice(word.lead ?? 0, word.nameEnd);

/** The rest of a command's first word after its name, cmd's first argument: user for net,user, /query for sc/query */
const afterName = (word: Token): string =>
  word.nameEnd === undefined ? '' : word.value.slice(word.nameEnd).replace(/^[;,=]+/, '');

/** The same rest as written, without the ; , = (and its ^) the name ends at */
const writtenAfterName = (word: Token): string =>
  word.textEnd === undefined ? '' : word.text.slice(word.textEnd).replace(/^(\^?[;,=])+/, '');

class CmdReader {
  private position = 0;
  readonly commands: FoundCommand[] = [];

  constructor(private readonly tokens: Token[], private readonly text: string) {}

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
    // Words of only ; , = and @ before the command are skipped, as spaces are (@ sc runs sc)
    while (this.tokens[this.position]?.kind === 'word' && isLead(this.tokens[this.position])) this.position++;
    const first = this.tokens[this.position];
    if (first === undefined || first.kind === 'op' || (first.kind === 'close' && inGroup)) return;
    if (first.kind === 'open') {
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
      if (token.kind === 'open' && parens === 0 && this.readForSet(words)) continue;
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

  /** A FOR /F quoted set is a command or literal, not part of the outer list. */
  private readForSet(words: Token[]): boolean {
    if (words.length === 0 || commandName(words[0]).toLowerCase() !== 'for'
      || words[words.length - 1].value.toLowerCase() !== 'in') return false;
    const rest = afterName(words[0]);
    // Comma/equal/semicolon may separate FOR from /F; an attached slash cannot.
    if (rest && !';,='.includes(words[0].value[words[0].nameEnd!])) return false;
    const args = [...(rest ? [rest] : []), ...words.slice(1).map(word => word.value)];
    if (args[0]?.toLowerCase() !== '/f') return false;
    const usebackq = /(?:^|\s)usebackq(?:\s|$)/i.test(args[1] ?? '');
    const open = this.tokens[this.position];
    let start = open.start + 1;
    while (/[ \t]/.test(this.text[start] ?? '') && start < this.text.length) start++;
    const quote = this.text[start];
    const isCommand = quote === (usebackq ? '`' : "'");
    const isLiteral = quote === (usebackq ? "'" : '"') || (usebackq && quote === '"');
    if (!isCommand && !isLiteral) return false;

    // Keep the raw span: tokenization removes quotes and splits the inner operators.
    let end = start + 1;
    let depth = 0;
    let inQuotes = false;
    let close = -1;
    for (; end < this.text.length; end++) {
      const char = this.text[end];
      if (isCommand && char === '^' && !inQuotes) { end++; continue; }
      if (isCommand && char === '"') inQuotes = !inQuotes;
      if (!inQuotes && depth === 0 && char === quote) {
        let next = end + 1;
        while (/[ \t]/.test(this.text[next] ?? '') && next < this.text.length) next++;
        if (this.text[next] === ')') { close = next; break; }
      }
      if (isCommand && !inQuotes) {
        if (char === '(') depth++;
        if (char === ')') depth--;
      }
    }
    if (close < 0) throw new Error('a for /f quoted set is not closed');
    if (isCommand) {
      // cmd consumes one caret-escape layer before passing the command to its child.
      let command = '';
      const offsets: number[] = [];
      inQuotes = false;
      for (let i = start + 1; i < end; i++) {
        const char = this.text[i];
        if (char === '"') inQuotes = !inQuotes;
        if (char === '^' && !inQuotes && i + 1 < end) i++;
        offsets.push(i);
        command += this.text[i];
      }
      const reader = new CmdReader(tokenize(command), command);
      reader.readList(false);
      this.commands.push(...reader.commands.map(found => ({ ...found, start: offsets[found.start] })));
    }
    // Retain a balanced placeholder so the existing DO/body/group logic still applies.
    words.push(open, { kind: 'close', value: ')', text: ')', start: close, atRunTime: false });
    while (this.position < this.tokens.length && this.tokens[this.position].start <= close) this.position++;
    return true;
  }

  /**
   * Whether the words so far are a whole if condition, a for clause up to its
   * "do", an "else" or a "call", so the next token starts the command that runs.
   * parens: how many of the words' ( are not closed yet.
   */
  private startsCommandAfter(words: Token[], parens: number): boolean {
    const first = commandName(words[0]).toLowerCase();
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
    const name = commandName(first);
    if (!name && words.length === 1) return; // "" alone runs nothing
    const rest = afterName(first);
    const firstWords = rest ? [name, rest] : [name];
    this.commands.push({
      name,
      words: [
        ...firstWords.map((word) => (first.atRunTime ? null : word)),
        ...words.slice(1).map((word) => (word.atRunTime ? null : word.value)),
      ],
      written: [
        ...(rest ? [first.text.slice(0, first.textEnd), writtenAfterName(first)] : [first.text]),
        ...words.slice(1).map((word) => word.text),
      ],
      wordTexts: [...firstWords, ...words.slice(1).map((word) => word.value)],
      start: first.start,
      nameAtRunTime: first.atRunTime,
    });
  }
}

/** Reads a command for cmd */
export async function readCmdCommands(command: string): Promise<CommandReading> {
  const reader = new CmdReader(tokenize(command), command);
  try {
    reader.readList(false);
  } catch (error) {
    return { commands: [], functions: [], parseError: error instanceof Error ? error.message : String(error) };
  }
  return { commands: reader.commands.sort((a, b) => a.start - b.start), functions: [] };
}
