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

/** Default calls retain the historical reading; native capabilities select one range grammar. */
export type BraceSemantics = 'legacy' | 'bash3' | 'bash5.2' | 'zsh';

export interface BraceOptions {
  semantics?: BraceSemantics;
}

/**
 * The most steps one expansion may take, a step being a character looked at
 * to find a brace or one put in a word. The words are bounded by
 * MAX_BRACE_WORDS, but the work to make them isn't: the rest of the word is
 * expanded again for each word of a list, and a nested group's braces take
 * a time that grows with the square of its depth. This keeps the check to a
 * fraction of a second; past it the check gives up, as past MAX_BRACE_WORDS.
 */
const MAX_BRACE_STEPS = 10_000_000;

/** Characters that are all text: a quoted part of a word, or a part with no brace syntax in it */
export function quotedChars(text: string): WordChar[] {
  // An empty quoted part still keeps its word after quote removal.
  return Array.from(text || [''], (char) => ({ char, quoted: true }));
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
 * the unquoted empty ones: bash drops {,sudo}'s empty word, but keeps {"",sudo}'s.
 * A word without an expansion gives itself. Past MAX_BRACE_WORDS words or
 * MAX_BRACE_STEPS steps it gives null, and the reader takes the command as
 * unreadable.
 */
export function braceWords(chars: WordChar[], { semantics = 'legacy' }: BraceOptions = {}): string[] | null {
  const words: string[] = [];
  const steps = { left: MAX_BRACE_STEPS, semantics };
  let read = 0;
  try {
    for (const word of expand(chars, steps)) {
      if (++read > MAX_BRACE_WORDS) return null;
      take(steps, word.text.length);
      if (word.text !== '' || word.quoted) words.push(word.text);
    }
  } catch (error) {
    if (error instanceof TooManySteps) return null;
    throw error;
  }
  return words;
}

/** The steps an expansion has left (MAX_BRACE_STEPS) */
type Steps = { left: number; semantics: BraceSemantics };

class TooManySteps extends Error {}

/** Takes n steps, or stops the expansion when there aren't that many left */
function take(steps: Steps, n: number): void {
  steps.left -= n;
  if (steps.left < 0) throw new TooManySteps();
}

const isSyntax = (c: WordChar, char: string): boolean => !c.quoted && c.char === char;
const textOf = (chars: WordChar[]): string => chars.map((c) => c.char).join('');

/** Yields the words of an expansion one at a time, so {1..1000000000} costs only the words that are read */
type ExpandedWord = { text: string; quoted: boolean };

function* expand(chars: WordChar[], steps: Steps): Generator<ExpandedWord> {
  const brace = findBrace(chars, steps);
  if (!brace) {
    yield { text: textOf(chars), quoted: chars.some((c) => c.quoted) };
    return;
  }
  const preamble = chars.slice(0, brace.open);
  const postscript = chars.slice(brace.close + 1);
  for (const middle of middles(chars, brace, steps)) {
    for (const end of expand(postscript, steps)) {
      yield {
        text: textOf(preamble) + middle.text + end.text,
        quoted: preamble.some((c) => c.quoted) || middle.quoted || end.quoted,
      };
    }
  }
}

/** A {a,b} list, with the places of its commas, or a {x..y} sequence, with its text */
type Brace = { open: number; close: number } & ({ commas: number[] } | { text: string });

/** The words that replace the braces, in order: each piece between the commas, expanded, or the sequence */
function* middles(chars: WordChar[], brace: Brace, steps: Steps): Generator<ExpandedWord> {
  if ('text' in brace) {
    // A generated backslash removed by Bash3/5.2 still keeps its empty argument after quote removal.
    for (const text of sequence(brace.text, steps)) yield { text, quoted: text === '' };
    return;
  }
  const bounds = [brace.open, ...brace.commas, brace.close];
  for (let k = 0; k + 1 < bounds.length; k++) {
    yield* expand(chars.slice(bounds[k] + 1, bounds[k + 1]), steps);
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
function findBrace(chars: WordChar[], steps: Steps): Brace | null {
  take(steps, chars.length);
  const { semantics } = steps;
  for (let open = 0; open < chars.length; open++) {
    if (!isSyntax(chars[open], '{')) continue;
    let depth = 0;
    let close = -1;
    const commas: number[] = [];
    let i = open + 1;
    for (; i < chars.length && close < 0; i++) {
      if (isSyntax(chars[i], '{')) {
        depth++;
      } else if (isSyntax(chars[i], '}')) {
        if (depth === 0) close = i;
        else depth--;
      } else if (depth === 0 && isSyntax(chars[i], ',')) {
        commas.push(i);
      }
    }
    take(steps, i - open);
    if (close < 0) continue;
    if (commas.length > 0) return { open, close, commas };
    const inside = chars.slice(open + 1, close);
    const text = textOf(inside);
    const range = NUMBERS.exec(text) ?? LETTERS.exec(text);
    if (semantics === 'zsh' && range && (range[1].startsWith('+') || range[2].startsWith('+'))) continue;
    if (semantics === 'zsh' && range?.[3] !== undefined
      && (range[3].startsWith('+') || LETTERS.test(text))) continue;
    if (inside.every((c) => !c.quoted) && range && !(semantics === 'bash3' && range[3] !== undefined)) {
      return { open, close, text };
    }
  }
  return null;
}

/** The words of a {1..10}, {01..10..2} or {a..e} sequence (findBrace has matched its text) */
function* sequence(text: string, { semantics }: Pick<Steps, 'semantics'>): Generator<string> {
  const numbers = NUMBERS.exec(text);
  if (numbers) {
    const [, first, last, increment] = numbers;
    if (semantics === 'zsh' && increment !== undefined && Number(increment) === 0) {
      yield text;
      return;
    }
    // Match bash: a leading zero (after -, not +) pads to the longer endpoint's width, including its sign.
    let width = semantics !== 'bash3' && (/^-?0\d/.test(first) || /^-?0\d/.test(last))
      ? Math.max(first.length, last.length) : 0;
    // Zsh takes the width from the first padded endpoint, even across a sign change.
    if (semantics === 'zsh' && width) width = /^-?0\d/.test(first) ? first.length : last.length;
    const pad = (n: number): string => (
      n < 0 ? '-' + String(-n).padStart(width - 1, '0') : String(n).padStart(width, '0')
    );
    for (const n of range(Number(first), Number(last), { increment, semantics })) yield pad(n);
    return;
  }
  const [, first, last, increment] = LETTERS.exec(text)!;
  for (const n of range(first.charCodeAt(0), last.charCodeAt(0), { increment, semantics })) {
    // Bash3/5.2 remove the generated backslash after expansion; Bash5.3 omits its whole word.
    if (n === 0x5c && (semantics === 'bash3' || semantics === 'bash5.2')) yield '';
    if (n !== 0x5c || semantics === 'zsh') yield String.fromCharCode(n);
  }
}

/** from, from ± step, … as far as to, in either direction; bash takes a missing or zero step as 1 */
function* range(from: number, to: number,
  { increment, semantics }: { increment: string | undefined; semantics: BraceSemantics }): Generator<number> {
  if (semantics === 'zsh' && Number(increment) < 0) [from, to] = [to, from];
  const size = Math.abs(Number(increment ?? 1)) || 1;
  const step = from <= to ? size : -size;
  for (let n = from; Math.abs(n - from) <= Math.abs(to - from); n += step) yield n;
}
