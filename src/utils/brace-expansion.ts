/**
 * Brace expansion, the way bash does it before it runs a command: x{1,2}y
 * becomes the words x1y and x2y, and {1..3} becomes 1 2 3. So {sudo,ls} runs
 * sudo, and su{d..d}o runs sudo too. zsh expands the same forms. The command
 * check's POSIX reader uses it to find the program such a command name runs.
 */

/** One character of a word, and whether it is quoted or escaped there: a quoted "{", "," or "}" is only text */
export interface WordChar {
  char: string;
  quoted: boolean;
}

/** The most words of one expansion the check reads; past that it gives up rather than check part of it */
export const MAX_BRACE_WORDS = 1000;

/** Characters that are all text: a quoted part of a word, or a part with no brace syntax in it */
export function quotedChars(text: string): WordChar[] {
  return Array.from(text, (char) => ({ char, quoted: true }));
}

/** Characters as written outside quotes, where a backslash makes the character after it text */
export function unquotedChars(text: string): WordChar[] {
  const chars: WordChar[] = [];
  const all = Array.from(text);
  for (let i = 0; i < all.length; i++) {
    if (all[i] === '\\' && i + 1 < all.length) {
      chars.push({ char: all[++i], quoted: true });
    } else {
      chars.push({ char: all[i], quoted: false });
    }
  }
  return chars;
}

/**
 * The words bash makes from a word by brace expansion, in bash's order, without
 * the empty ones: bash drops an empty unquoted word, so {,sudo} ls runs sudo.
 * A word without an expansion gives itself. Past MAX_BRACE_WORDS words it
 * gives null, and the reader takes the command as unreadable.
 */
export function braceWords(chars: WordChar[]): string[] | null {
  const words: string[] = [];
  let read = 0;
  for (const word of expand(chars)) {
    if (++read > MAX_BRACE_WORDS) return null;
    if (word !== '') words.push(word);
  }
  return words;
}

const isSyntax = (c: WordChar, char: string): boolean => !c.quoted && c.char === char;
const textOf = (chars: WordChar[]): string => chars.map((c) => c.char).join('');

/** Yields the words of an expansion one at a time, so {1..1000000000} costs only the words that are read */
function* expand(chars: WordChar[]): Generator<string> {
  const brace = findBrace(chars);
  if (!brace) {
    yield textOf(chars);
    return;
  }
  const preamble = textOf(chars.slice(0, brace.open));
  const postscript = chars.slice(brace.close + 1);
  for (const middle of middles(chars, brace)) {
    for (const end of expand(postscript)) {
      yield preamble + middle + end;
    }
  }
}

/** A {a,b} list, with the places of its commas, or a {x..y} sequence, with its text */
type Brace = { open: number; close: number } & ({ commas: number[] } | { text: string });

/** The words that replace the braces, in order: each piece between the commas, expanded, or the sequence */
function* middles(chars: WordChar[], brace: Brace): Generator<string> {
  if ('text' in brace) {
    yield* sequence(brace.text);
    return;
  }
  const bounds = [brace.open, ...brace.commas, brace.close];
  for (let k = 0; k + 1 < bounds.length; k++) {
    yield* expand(chars.slice(bounds[k] + 1, bounds[k + 1]));
  }
}

// bash reads a number here with its sign, - or +: su{d..d..+1}o runs sudo
const NUMBERS = /^([-+]?\d+)\.\.([-+]?\d+)(?:\.\.([-+]?\d+))?$/;
const LETTERS = /^([A-Za-z])\.\.([A-Za-z])(?:\.\.([-+]?\d+))?$/;

/**
 * The first {a,b} or {x..y} in the word. As in bash, a "{" without a matching
 * "}", or whose braces hold neither a comma nor a sequence ({sudo}), is text,
 * and the search goes on after it.
 */
function findBrace(chars: WordChar[]): Brace | null {
  for (let open = 0; open < chars.length; open++) {
    if (!isSyntax(chars[open], '{')) continue;
    let depth = 0;
    let close = -1;
    const commas: number[] = [];
    for (let i = open + 1; i < chars.length && close < 0; i++) {
      if (isSyntax(chars[i], '{')) {
        depth++;
      } else if (isSyntax(chars[i], '}')) {
        if (depth === 0) close = i;
        else depth--;
      } else if (depth === 0 && isSyntax(chars[i], ',')) {
        commas.push(i);
      }
    }
    if (close < 0) continue;
    if (commas.length > 0) return { open, close, commas };
    const inside = chars.slice(open + 1, close);
    const text = textOf(inside);
    if (inside.every((c) => !c.quoted) && (NUMBERS.test(text) || LETTERS.test(text))) return { open, close, text };
  }
  return null;
}

/** The words of a {1..10}, {01..10..2} or {a..e} sequence (findBrace has matched its text) */
function* sequence(text: string): Generator<string> {
  const numbers = NUMBERS.exec(text);
  if (numbers) {
    const [, first, last, increment] = numbers;
    // A leading zero on either end (after a -, not a +) pads every number to the longer end's width, sign included, as bash does
    const width = /^-?0\d/.test(first) || /^-?0\d/.test(last) ? Math.max(first.length, last.length) : 0;
    const pad = (n: number): string => (n < 0 ? '-' + String(-n).padStart(width - 1, '0') : String(n).padStart(width, '0'));
    for (const n of range(Number(first), Number(last), increment)) yield pad(n);
    return;
  }
  const [, first, last, increment] = LETTERS.exec(text)!;
  for (const n of range(first.charCodeAt(0), last.charCodeAt(0), increment)) {
    // bash leaves out the backslash, which lies between "Z" and "a"
    if (n !== 0x5c) yield String.fromCharCode(n);
  }
}

/** from, from ± step, … as far as to, in either direction; bash takes a missing or zero step as 1 */
function* range(from: number, to: number, increment: string | undefined): Generator<number> {
  const size = Math.abs(Number(increment ?? 1)) || 1;
  const step = from <= to ? size : -size;
  for (let n = from; Math.abs(n - from) <= Math.abs(to - from); n += step) yield n;
}
