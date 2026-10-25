/** Windows PowerShell (powershell.exe, 5.1) or PowerShell (pwsh, 6 and later) */
export type PowerShellEdition = 'windows-powershell' | 'powershell';

/**
 * The command name of each command the edition of PowerShell would run for a
 * script, as written with quotes and escapes removed, in order. The words of an
 * expression, strings, here-strings, hashtable key names and comments are data.
 * A command invoked through a variable or an expression (& $tool) is left out:
 * its name is only known when the script runs.
 */
export function powershellCommandWords(script: string, edition: PowerShellEdition): string[] {
  const scanner = new PowerShellScanner(script, edition);
  scanner.statements();
  return scanner.words;
}

// PowerShell takes the typographic quotes as quotes too
const SINGLE_QUOTES = new Set(["'", '‘', '’', '‚', '‛']);
const DOUBLE_QUOTES = new Set(['"', '“', '”', '„']);
// Blanks between words: U+2028 and U+2029 don't end a line, and a U+FEFF stays part of a name
const BLANK_CHARS = String.raw` \t\f\v\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000`;
const BLANK = new RegExp(`[${BLANK_CHARS}]`);
// Characters that end a bare word: a command name or an unquoted argument. < > and # end one only
// where a word starts (a>b is one word), and so do redirections and comments.
const BARE_WORD_END = '{}();,|&\r\n';
// What ends a pipeline element: a new line, a statement or pipeline separator, or a closing bracket
const ELEMENT_END = '\r\n;|&)}';
// A parameter token: a dash (typographic ones too) and a letter, _ or ?. $ and ` in it are plain
// text; it ends where a bare word does, at . or [, or after a :
const PARAMETER_START = /[-–—―][\p{L}_?]/uy;
const PARAMETER_END = `${BARE_WORD_END}.[`;
const WINDOWS_POWERSHELL_ESCAPES = new Map([['0', '\0'], ['a', '\x07'], ['b', '\b'], ['f', '\f'], ['n', '\n'], ['r', '\r'], ['t', '\t'], ['v', '\v']]);
const ESCAPES: Record<PowerShellEdition, Map<string, string>> = {
  'windows-powershell': WINDOWS_POWERSHELL_ESCAPES,
  powershell: new Map([...WINDOWS_POWERSHELL_ESCAPES, ['e', '\x1b']]),
};
// PowerShell 6 and later only; `u{110000} and above is a parse error
const UNICODE_ESCAPE = /`u\{([0-9A-Fa-f]{1,6})\}/y;
const KEYWORDS = new Set([
  'if', 'elseif', 'else', 'while', 'until', 'for', 'foreach', 'switch', 'do', 'try', 'catch', 'finally', 'trap',
  'function', 'filter', 'workflow', 'configuration', 'param', 'begin', 'process', 'end', 'dynamicparam', 'data',
  'return', 'throw', 'exit', 'break', 'continue', 'class', 'enum', 'using',
]);
// The clauses that belong to the statement before them, also on a later line. One that starts a
// statement is a command name: `else x` runs a command named else.
const CLAUSES = new Set(['elseif', 'else', 'catch', 'finally', 'until']);
const IF_CLAUSES = new Set(['elseif', 'else']);
const TRY_CLAUSES = new Set(['catch', 'finally']);
const DO_CLAUSES = new Set(['while', 'until']);
const KEYWORD = /[A-Za-z]+/y;
const LOOP_LABEL = /:\w+/y;
// A label belongs to one of these; before anything else :name is a command name
const LOOPS = new Set(['for', 'foreach', 'while', 'do', 'switch']);
// A keyword followed by anything else is part of a longer word (ForEach-Object, if>x)
const AFTER_KEYWORD = /[\s({;)}|&,]/;
// At a statement's start these make an expression; any other -Name is a command name
const UNARY_OPERATORS = new Set(['-not', '-bnot', '-split', '-join']);
const VALUE_KEYWORDS = new Set(['return', 'throw', 'exit']);
const DASH_WORD = /-[A-Za-z]+/y;
const NUMBER = /(?:0x[0-9a-f]+|(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(?:ul|lu|uy|us|[ludysn])?(?:kb|mb|gb|tb|pb)?/iy;
// A number token is followed by one of these; otherwise it starts a command name (7z)
const AFTER_NUMBER = /[\s;)}\],|&+\-*/%=<>!.]/;
const REDIRECTION = /[1-6*]?>>?(?:&[1-6])?|</y;
const HERE_STRING_START = new RegExp(String.raw`@['‘’‚‛"“”„][${BLANK_CHARS}]*(?:\r\n|\r|\n)`, 'y');
const FINAL_LINE_END = /(?:\r\n|\r|\n)$/;
const VARIABLE_START = /\$[\w({?$^]/y;

interface Word {
  value: string;
  // Some part expands when the script runs: the value is not known before
  expanded: boolean;
}

const NO_NAME: Word = { value: '', expanded: true };

function isSingleQuote(c: string | undefined): boolean {
  return c !== undefined && SINGLE_QUOTES.has(c);
}

function isDoubleQuote(c: string | undefined): boolean {
  return c !== undefined && DOUBLE_QUOTES.has(c);
}

class PowerShellScanner {
  readonly words: string[] = [];
  private pos = 0;

  constructor(
    private readonly src: string,
    private readonly edition: PowerShellEdition,
  ) {}

  /** Statements until the end, or until `close` (left unread) */
  statements(close?: string): void {
    while (this.pos < this.src.length) {
      this.skipSpace(true);
      const c = this.src[this.pos];
      if (c === undefined || c === close) return;
      const before = this.pos;
      if (c === ';' || c === ')' || c === '}') {
        this.pos++; // a separator, or a bracket nothing opened
      } else if (c === '|') {
        this.pos++; // a line that starts with | continues the pipeline above it
        this.statement(false);
      } else {
        this.statement(true);
      }
      if (this.pos === before) this.pos++;
    }
  }

  private at(text: string): boolean {
    return this.src.startsWith(text, this.pos);
  }

  private matchAt(pattern: RegExp): string | undefined {
    pattern.lastIndex = this.pos;
    return pattern.exec(this.src)?.[0];
  }

  /** Pipelines joined by |, && and || */
  private statement(keywordsAllowed: boolean): void {
    const keywordStatement = this.element(keywordsAllowed);
    while (this.pos < this.src.length) {
      this.skipSpace(false);
      if (this.at('&&') || this.at('||')) {
        this.pos += 2;
      } else if (this.src[this.pos] === '|') {
        this.pos++;
      } else {
        // After a pipeline PowerShell 7 reads & as "run in the background"; after a keyword
        // statement it calls what follows, so it is left for the next statement
        if (!keywordStatement && this.src[this.pos] === '&') this.pos++;
        return;
      }
      this.skipSpace(true);
      this.element(false);
    }
  }

  /** One pipeline element: a keyword statement, a command, or an expression. True for a keyword statement. */
  private element(keywordsAllowed: boolean): boolean {
    this.skipSpace(false);
    const label = this.matchAt(LOOP_LABEL);
    if (label !== undefined) {
      const start = this.pos;
      this.pos += label.length;
      this.skipSpace(true);
      if (this.keywordAt(LOOPS) === undefined) this.pos = start;
    }
    const c = this.src[this.pos];
    if (c === undefined) return false;
    if (c === '&' && !this.at('&&')) {
      this.pos++;
      this.command(true);
      return false;
    }
    if (ELEMENT_END.includes(c)) return false;
    // A return, throw or exit value is a pipeline: an & after it runs it in the background
    const keyword = keywordsAllowed ? this.keywordAt(KEYWORDS) : undefined;
    if (keyword !== undefined && this.keyword()) return !VALUE_KEYWORDS.has(keyword);
    if (c === '.' && this.isDotSourcing()) {
      this.pos++;
      this.command(true);
    } else if (this.startsExpression()) {
      this.expression();
    } else {
      this.command(false);
    }
    return false;
  }

  private command(invoked: boolean): void {
    this.skipSpace(false);
    const operator = invoked ? undefined : this.matchAt(REDIRECTION);
    if (operator !== undefined && this.redirection()) {
      this.words.push(operator); // a redirection first (2>&1 x): PowerShell names the command after it
      this.arguments();
      return;
    }
    const name = invoked ? this.invokedName() : this.bareWord(true);
    if (!name.expanded && name.value !== '') this.words.push(name.value);
    this.arguments();
  }

  /** What & or . runs: a name or path, or a script block, variable or expression (no name) */
  private invokedName(): Word {
    const c = this.src[this.pos];
    if (c === undefined) return NO_NAME;
    if (isSingleQuote(c) || isDoubleQuote(c) || this.hereStringAt()) return this.string();
    if (c === '{') {
      this.block();
      return NO_NAME;
    }
    if (c === '(') {
      this.paren();
      return NO_NAME;
    }
    if (c === '$' || c === '@') {
      this.operand();
      return NO_NAME;
    }
    return this.bareWord();
  }

  private arguments(): void {
    while (this.pos < this.src.length) {
      this.skipSpace(false);
      const c = this.src[this.pos];
      if (c === undefined || ELEMENT_END.includes(c)) return;
      if (this.atStopParsing()) {
        // The rest of the line goes to the program as written, ; and & too, up to | || or && outside "..."
        let quoted = false;
        for (; this.pos < this.src.length && !'\r\n'.includes(this.src[this.pos]); this.pos++) {
          if (isDoubleQuote(this.src[this.pos])) quoted = !quoted;
          else if (!quoted && (this.src[this.pos] === '|' || this.at('&&'))) break;
        }
        return;
      }
      const before = this.pos;
      this.argument();
      if (this.pos === before) this.pos++;
    }
  }

  private argument(): void {
    const c = this.src[this.pos];
    const next = this.src[this.pos + 1];
    if (this.redirection()) return;
    if (c === ',') {
      this.pos++;
      this.skipSpace(true); // a list of arguments goes on after a comma at a line's end
    } else if (isSingleQuote(c) || isDoubleQuote(c) || this.hereStringAt()) {
      this.string();
    } else if (c === '(') {
      this.paren();
    } else if (c === '{') {
      this.block();
    } else if (c === '$' || (c === '@' && (next === '(' || next === '{'))) {
      this.operand();
    } else {
      this.bareWord();
    }
  }

  /**
   * A bare word: a command name or an unquoted argument, with its quotes and escapes removed. In a
   * command name $ is text: $x and $( ) stay as written, and nothing in them runs.
   */
  private bareWord(isName = false): Word {
    if (this.src[this.pos] === ']') {
      this.pos++; // a word on its own: ]#x is ] and then a comment
      return { value: ']', expanded: false };
    }
    const parameter = this.parameter();
    if (parameter !== undefined) return parameter;
    let value = '';
    let expanded = false;
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (BARE_WORD_END.includes(c) || BLANK.test(c)) break;
      if (c === '`') {
        const next = this.src[this.pos + 1];
        if (next === undefined || next === '\r' || next === '\n') break; // a line continuation
        value += this.escape();
      } else if (isSingleQuote(c)) {
        value += this.singleQuoted();
      } else if (isDoubleQuote(c)) {
        const part = this.doubleQuoted(isName);
        value += part.value;
        expanded ||= part.expanded;
      } else if (c === '$' && this.matchAt(VARIABLE_START) && isName) {
        value += this.asText(() => this.expansion());
      } else if (c === '$' && this.matchAt(VARIABLE_START)) {
        this.expansion();
        expanded = true;
      } else {
        value += c;
        this.pos++;
      }
    }
    return { value, expanded };
  }

  /** Reads past what `read` reads and returns it as written, without the commands in it: none of them runs */
  private asText(read: () => void): string {
    const start = this.pos;
    const recorded = this.words.length;
    read();
    this.words.length = recorded;
    return this.src.slice(start, this.pos);
  }

  /** A parameter token (-Name), as written; undefined when a quote in it makes it a bare word */
  private parameter(): Word | undefined {
    if (this.matchAt(PARAMETER_START) === undefined) return undefined;
    let end = this.pos + 2;
    for (; end < this.src.length; end++) {
      const c = this.src[end];
      if (isSingleQuote(c) || isDoubleQuote(c)) return undefined;
      if (PARAMETER_END.includes(c) || BLANK.test(c)) break;
      if (c === ':') {
        end++;
        break;
      }
    }
    const value = this.src.slice(this.pos, end);
    this.pos = end;
    return { value, expanded: false };
  }

  /** At a backtick: the character it escapes, decoded as the edition does */
  private escape(): string {
    UNICODE_ESCAPE.lastIndex = this.pos;
    const hex = this.edition === 'powershell' ? UNICODE_ESCAPE.exec(this.src)?.[1] : undefined;
    if (hex !== undefined && Number.parseInt(hex, 16) <= 0x10ffff) {
      this.pos = UNICODE_ESCAPE.lastIndex;
      return String.fromCodePoint(Number.parseInt(hex, 16));
    }
    const next = this.src[this.pos + 1] ?? '';
    this.pos += 2;
    return ESCAPES[this.edition].get(next) ?? next;
  }

  /**
   * The rest of a statement in expression mode: a bare word here is never a command.
   * untilAssignment: stop before an = (a hashtable key), instead of reading what it assigns.
   */
  private expression(untilAssignment = false): void {
    let nameEnd = -1;
    while (this.pos < this.src.length) {
      this.skipSpace(false);
      const c = this.src[this.pos];
      if (c === undefined || ELEMENT_END.includes(c)) return;
      const assignment = this.assignmentLength();
      if (assignment > 0 && untilAssignment) return;
      if (assignment > 0) {
        this.pos += assignment;
        this.skipSpace(true);
        this.element(true); // what is assigned is a statement, so it can run a command: $x = Get-Date
        return;
      }
      if (this.redirection()) continue;
      if (c === '(' && this.pos === nameEnd) {
        this.methodArguments(); // a call: Name(...)
      } else if (c === '(') {
        this.paren();
      } else if (isSingleQuote(c) || isDoubleQuote(c) || this.hereStringAt()) {
        this.string();
      } else if (c === '$' || c === '@') {
        this.operand();
      } else if (c === '{') {
        this.block();
      } else if (c === '[') {
        this.pos++;
        this.bracketed(); // a type: [string](...) casts what follows, it doesn't call it
      } else if (/\w/.test(c)) {
        const member = this.src[this.pos - 1] === '.' || this.src[this.pos - 1] === ':';
        while (this.pos < this.src.length && /\w/.test(this.src[this.pos])) this.pos++;
        if (member) nameEnd = this.pos;
      } else if (c === '-' && /[A-Za-z]/.test(this.src[this.pos + 1] ?? '')) {
        this.pos++; // an operator: -eq, -and, -replace, ...
        while (this.pos < this.src.length && /[A-Za-z]/.test(this.src[this.pos])) this.pos++;
      } else {
        this.pos++;
      }
    }
  }

  private assignmentLength(): number {
    if (this.at('??=')) return 3;
    const c = this.src[this.pos];
    if ('+-*/%'.includes(c) && this.src[this.pos + 1] === '=') return 2;
    return c === '=' ? 1 : 0;
  }

  /** At $ or @: a variable, $( ), @( ), @{ } or a splat, then its members */
  private operand(): void {
    if (this.at('$(') || this.at('@(')) {
      this.pos++;
      this.paren();
    } else if (this.at('@{')) {
      this.hashtable();
    } else if (this.matchAt(VARIABLE_START)) {
      this.variable();
    } else {
      this.pos++; // a splat (@name), or a lone $ or @
      while (this.pos < this.src.length && /\w/.test(this.src[this.pos])) this.pos++;
    }
    this.members();
  }

  // At '$': $name, $env:NAME, ${any name}, $_, $?, $$ or $^
  private variable(): void {
    const next = this.src[this.pos + 1];
    if (next === '{') {
      const end = this.src.indexOf('}', this.pos);
      this.pos = end === -1 ? this.src.length : end + 1;
      return;
    }
    this.pos += 2;
    if (next === '?' || next === '$' || next === '^') return;
    while (this.pos < this.src.length && /[\w:]/.test(this.src[this.pos])) this.pos++;
  }

  // Right after an operand: .Name, ::Name, [index], and the arguments of a method call
  private members(): void {
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === '[') {
        this.pos++;
        this.bracketed();
      } else if ((c === '.' && this.src[this.pos + 1] !== '.') || this.at('::')) {
        this.pos += c === '.' ? 1 : 2;
        this.memberName();
        if (this.src[this.pos] === '(') this.methodArguments();
      } else {
        return;
      }
    }
  }

  private memberName(): void {
    const c = this.src[this.pos];
    if (isSingleQuote(c) || isDoubleQuote(c)) {
      this.string();
    } else if (c === '$') {
      this.operand();
    } else if (c === '(') {
      this.paren(); // $x.(cmd) runs cmd for the name
    } else {
      while (this.pos < this.src.length && /\w/.test(this.src[this.pos])) this.pos++;
    }
  }

  // After '[': a type, an attribute or an index, through the matching ']'
  private bracketed(): void {
    let afterName = false;
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === ']') {
        this.pos++;
        return;
      }
      if (BLANK.test(c) || c === '\r' || c === '\n') {
        this.pos++;
        continue; // a name stays just before a ( after blanks: [Parameter (Mandatory)]
      }
      if (c === '(' && afterName) {
        this.methodArguments(); // attribute arguments
      } else if (c === '(') {
        this.paren();
      } else if (c === '[') {
        this.pos++;
        this.bracketed();
      } else if (isSingleQuote(c) || isDoubleQuote(c)) {
        this.string();
      } else if (c === '{') {
        this.block();
      } else if (c === '$') {
        this.operand();
      } else if (/\w/.test(c)) {
        while (this.pos < this.src.length && /\w/.test(this.src[this.pos])) this.pos++;
        afterName = true;
        continue;
      } else {
        this.pos++;
      }
      afterName = false;
    }
  }

  // At '(' of a method call or attribute: expressions, not statements
  private methodArguments(): void {
    this.pos++;
    while (this.pos < this.src.length) {
      this.skipSpace(true);
      const c = this.src[this.pos];
      if (c === undefined || c === ')') break;
      const before = this.pos;
      this.expression();
      if (this.pos === before) this.pos++; // a separator: , ; | & or }
    }
    this.closeWith(')');
  }

  private paren(): void {
    this.pos++;
    this.statements(')');
    this.closeWith(')');
  }

  private block(): void {
    this.pos++;
    this.statements('}');
    this.closeWith('}');
  }

  private closeWith(c: string): void {
    if (this.src[this.pos] === c) this.pos++;
  }

  // At '@{': key = statement entries, separated by ; or new lines
  private hashtable(): void {
    this.pos += 2;
    while (this.pos < this.src.length) {
      this.skipSpace(true);
      const c = this.src[this.pos];
      if (c === '}') {
        this.pos++;
        return;
      }
      const before = this.pos;
      if (c === ';') {
        this.pos++;
        continue;
      }
      this.expression(true); // the key: a name, or an expression whose commands run (@{ (cmd) = 1 })
      this.skipSpace(false);
      if (this.src[this.pos] === '=') {
        this.pos++;
        this.skipSpace(true);
        this.statement(true);
      }
      if (this.pos === before) this.pos++;
    }
  }

  private redirection(): boolean {
    const operator = this.matchAt(REDIRECTION);
    if (operator === undefined) return false;
    this.pos += operator.length;
    if (operator.includes('&')) return true; // 2>&1 merges streams: no file follows
    this.skipSpace(false);
    const c = this.src[this.pos];
    // --% stops parsing even here, rather than naming the file
    if (c !== undefined && !ELEMENT_END.includes(c) && !this.atStopParsing()) this.argument();
    return true;
  }

  // --% as a word on its own (--%x is a plain word)
  private atStopParsing(): boolean {
    const after = this.src[this.pos + 3];
    return this.at('--%') && (after === undefined || after === '\r' || after === '\n' || BLANK.test(after));
  }

  /** A string literal; `expanded` when it holds $ expansions */
  private string(): Word {
    if (this.hereStringAt()) return this.hereString();
    if (isSingleQuote(this.src[this.pos])) return { value: this.singleQuoted(), expanded: false };
    return this.doubleQuoted();
  }

  private singleQuoted(): string {
    let value = '';
    this.pos++;
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (isSingleQuote(c)) {
        if (!isSingleQuote(this.src[this.pos + 1])) {
          this.pos++;
          return value;
        }
        this.pos++; // a doubled quote is one quote character
      }
      value += c;
      this.pos++;
    }
    return value;
  }

  /** A "..." string; in a command name its $x and $( ) are text, as in a bare one */
  private doubleQuoted(isName = false): Word {
    let value = '';
    let expanded = false;
    this.pos++;
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (isDoubleQuote(c) && !isDoubleQuote(this.src[this.pos + 1])) {
        this.pos++;
        return { value, expanded };
      }
      if (isDoubleQuote(c)) {
        value += c;
        this.pos += 2; // a doubled quote is one quote character
        continue;
      }
      const part = this.expandableText(isName);
      value += part.value;
      expanded ||= part.expanded;
    }
    return { value, expanded };
  }

  // In "..." or @"..."@: an escape, an expansion, or one character
  private expandableText(isName: boolean): Word {
    const c = this.src[this.pos];
    if (c === '`') return { value: this.escape(), expanded: false };
    if (!this.at('$(') && this.matchAt(VARIABLE_START) === undefined) {
      this.pos++;
      return { value: c, expanded: false };
    }
    if (isName) return { value: this.asText(() => this.expansion()), expanded: false };
    this.expansion();
    return { value: '', expanded: true };
  }

  // In a bare word or "...": $( ) or a variable; what follows the variable (.Name, [0]) is text
  private expansion(): void {
    if (this.at('$(')) {
      this.pos++;
      this.paren();
    } else {
      this.variable();
    }
  }

  private hereStringAt(): boolean {
    return this.matchAt(HERE_STRING_START) !== undefined;
  }

  // @'...'@ is literal; @"..."@ reads as "..." does, but a doubled quote stays two. The closing quote
  // and @ start a line that no escape continued, and the line end before them is not in the value.
  private hereString(): Word {
    const expandable = isDoubleQuote(this.src[this.pos + 1]);
    const closes = expandable ? isDoubleQuote : isSingleQuote;
    this.pos += (this.matchAt(HERE_STRING_START) ?? '').length;
    let value = '';
    let expanded = false;
    let lineStart = true;
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (lineStart && closes(c) && this.src[this.pos + 1] === '@') {
        this.pos += 2;
        return { value: value.replace(FINAL_LINE_END, ''), expanded };
      }
      lineStart = c === '\n' || c === '\r';
      if (expandable) {
        const part = this.expandableText(false);
        value += part.value;
        expanded ||= part.expanded;
      } else {
        value += c;
        this.pos++;
      }
    }
    return { value, expanded };
  }

  /** Skips blanks, comments and line continuations; with `newlines` also new lines */
  private skipSpace(newlines: boolean): void {
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      const next = this.src[this.pos + 1];
      if (BLANK.test(c)) {
        this.pos++;
      } else if (c === '`' && next !== undefined && BLANK.test(next)) {
        this.pos += 2; // an escaped blank between words is a blank
      } else if (c === '`' && (next === '\n' || next === '\r')) {
        this.pos += this.at('`\r\n') ? 3 : 2; // a line continuation
      } else if (newlines && (c === '\n' || c === '\r')) {
        this.pos++;
      } else if (c === '#') {
        this.skipToLineEnd();
      } else if (this.at('<#')) {
        const end = this.src.indexOf('#>', this.pos + 2);
        this.pos = end === -1 ? this.src.length : end + 2;
      } else {
        return;
      }
    }
  }

  private skipToLineEnd(): void {
    while (this.pos < this.src.length && this.src[this.pos] !== '\n' && this.src[this.pos] !== '\r') this.pos++;
  }

  private isDotSourcing(): boolean {
    const next = this.src[this.pos + 1];
    return next !== undefined && (BLANK.test(next) || isSingleQuote(next) || isDoubleQuote(next) || '${(@'.includes(next));
  }

  private startsExpression(): boolean {
    const c = this.src[this.pos];
    const next = this.src[this.pos + 1];
    // 2>&1 or += first: the statement is a command
    if (this.matchAt(REDIRECTION) !== undefined || this.assignmentLength() > 0) return false;
    const dashWord = this.matchAt(DASH_WORD);
    if (dashWord !== undefined) return UNARY_OPERATORS.has(dashWord.toLowerCase());
    if ('$([{-+!,'.includes(c) || isSingleQuote(c) || isDoubleQuote(c)) return true;
    if (c === '@') return next !== undefined && (/[\w({]/.test(next) || isSingleQuote(next) || isDoubleQuote(next));
    const number = this.matchAt(NUMBER);
    if (number === undefined) return false;
    const after = this.src[this.pos + number.length];
    return after === undefined || AFTER_NUMBER.test(after);
  }

  // The keyword from `keywords` that starts here as a whole word, if any
  private keywordAt(keywords: Set<string>): string | undefined {
    const letters = this.matchAt(KEYWORD);
    if (letters === undefined) return undefined;
    const word = letters.toLowerCase();
    const after = this.src[this.pos + letters.length];
    return keywords.has(word) && (after === undefined || AFTER_KEYWORD.test(after)) ? word : undefined;
  }

  // Reads the next keyword from `clauses`, past blanks, new lines and comments; otherwise reads nothing
  private nextClause(clauses: Set<string>): string | undefined {
    const start = this.pos;
    this.skipSpace(true);
    const clause = this.keywordAt(clauses);
    this.pos = clause === undefined ? start : this.pos + clause.length;
    return clause;
  }

  /** At a statement's first word: reads a keyword statement's own parts, or returns false */
  private keyword(): boolean {
    const word = this.keywordAt(KEYWORDS);
    if (word === undefined || CLAUSES.has(word)) return false;
    const start = this.pos;
    this.pos += word.length;
    switch (word) {
      case 'if':
        this.condition();
        this.body();
        for (let clause = this.nextClause(IF_CLAUSES); clause !== undefined; clause = this.nextClause(IF_CLAUSES)) {
          if (clause === 'elseif') this.condition();
          this.body();
        }
        break;
      case 'try':
        this.body();
        for (let clause = this.nextClause(TRY_CLAUSES); clause !== undefined; clause = this.nextClause(TRY_CLAUSES)) {
          if (clause === 'catch') this.skipTypes();
          this.body();
        }
        break;
      case 'do':
        this.body();
        if (this.nextClause(DO_CLAUSES) !== undefined) this.condition();
        break;
      case 'while':
      case 'for':
        this.condition();
        this.body();
        break;
      case 'foreach':
        this.skipFlags();
        this.foreachHeader();
        this.body();
        break;
      case 'switch':
        this.switchStatement();
        break;
      case 'function':
      case 'filter':
      case 'workflow':
      case 'configuration':
        this.skipSpace(false);
        this.bareWord(); // the name
        this.condition(); // parameters, whose defaults can run commands
        this.body();
        break;
      case 'param':
        this.skipSpace(true);
        if (this.src[this.pos] !== '(') {
          this.pos = start; // without ( after it, param is a command name
          return false;
        }
        this.paren();
        break;
      case 'trap':
        this.skipTypes();
        this.body();
        break;
      case 'data':
        // data [Name] [-SupportedCommand Name, ...] { ... }
        this.skipWordsToBody();
        this.body();
        break;
      case 'return':
      case 'throw':
      case 'exit':
        this.element(false); // the value is a pipeline
        break;
      case 'break':
      case 'continue':
        this.skipSpace(false);
        this.bareWord(); // a label
        break;
      case 'class':
        this.classDefinition();
        break;
      case 'enum':
        this.enumDefinition();
        break;
      case 'using':
        this.arguments(); // namespace or module and a name: the statement ends at ; like any other
        break;
      default:
        this.body(); // begin, process, end, dynamicparam
    }
    return true;
  }

  // Bare words and commas up to a statement's { body } on the same line
  private skipWordsToBody(): void {
    while (this.pos < this.src.length) {
      this.skipSpace(false);
      const c = this.src[this.pos];
      if (c === undefined || c === '{' || ELEMENT_END.includes(c)) return;
      const before = this.pos;
      if (c === ',') this.pos++;
      else this.bareWord();
      if (this.pos === before) return;
    }
  }

  private condition(): void {
    this.skipSpace(true);
    if (this.src[this.pos] === '(') this.paren();
  }

  private body(): void {
    this.skipSpace(true);
    if (this.src[this.pos] === '{') this.block();
  }

  private skipFlags(): void {
    this.skipSpace(false);
    while (this.src[this.pos] === '-') {
      this.bareWord();
      this.skipSpace(false);
    }
  }

  private skipTypes(): void {
    while (this.pos < this.src.length) {
      this.skipSpace(false);
      if (this.src[this.pos] === '[') {
        this.pos++;
        this.bracketed();
      } else if (this.src[this.pos] === ',') {
        this.pos++;
      } else {
        return;
      }
    }
  }

  // ($item in <pipeline>): the pipeline after `in` can run commands
  private foreachHeader(): void {
    this.skipSpace(true);
    if (this.src[this.pos] !== '(') return;
    this.pos++;
    this.skipSpace(true);
    if (this.src[this.pos] === '$') this.operand();
    this.skipSpace(true);
    if (this.src.slice(this.pos, this.pos + 2).toLowerCase() === 'in' && !/\w/.test(this.src[this.pos + 2] ?? '')) {
      this.pos += 2;
    }
    this.statements(')');
    this.closeWith(')');
  }

  private switchStatement(): void {
    this.skipSpace(false);
    while (this.src[this.pos] === '-') {
      const flag = this.bareWord().value.toLowerCase();
      this.skipSpace(false);
      if (flag === '-file') {
        this.argument();
        this.skipSpace(false);
      }
    }
    this.condition();
    this.skipSpace(true);
    if (this.src[this.pos] !== '{') return;
    this.pos++;
    while (this.pos < this.src.length) {
      this.skipSpace(true);
      const c = this.src[this.pos];
      if (c === '}') {
        this.pos++;
        return;
      }
      const before = this.pos;
      if (c !== ';') this.switchClause();
      if (this.pos === before) this.pos++;
    }
  }

  // A condition (a value, or a script block that runs) and the body run when it matches
  private switchClause(): void {
    const c = this.src[this.pos];
    if (c === '{') {
      this.block();
    } else if (c === '(') {
      this.paren();
    } else if (isSingleQuote(c) || isDoubleQuote(c)) {
      this.string();
    } else if (c === '$') {
      this.operand();
    } else {
      this.bareWord();
    }
    this.body();
  }

  // class Name [: Base] { [type] $Property = value; Method([params]) { body } }
  private classDefinition(): void {
    while (this.pos < this.src.length && this.src[this.pos] !== '{') {
      const before = this.pos;
      this.skipSpace(true);
      if (this.src[this.pos] === ':' || this.src[this.pos] === ',') this.pos++;
      else if (this.src[this.pos] !== '{') this.bareWord();
      if (this.pos === before) this.pos++;
    }
    if (this.src[this.pos] !== '{') return;
    this.pos++;
    while (this.pos < this.src.length) {
      this.skipSpace(true);
      const c = this.src[this.pos];
      if (c === '}') {
        this.pos++;
        return;
      }
      const before = this.pos;
      if (c === '[') {
        this.pos++;
        this.bracketed();
      } else if (c === '$') {
        this.operand();
      } else if (c === '=') {
        this.pos++;
        this.element(false); // a property's default value
      } else if (c === '(') {
        this.paren(); // a method's parameters
      } else if (c === '{') {
        this.block(); // a method's body
      } else if (c === ';' || c === ':') {
        this.pos++;
      } else {
        this.bareWord(); // hidden, static, a method name, base
      }
      if (this.pos === before) this.pos++;
    }
  }

  // enum Name { A; B = 2 }: names and constants, never commands
  private enumDefinition(): void {
    const open = this.src.indexOf('{', this.pos);
    const close = open === -1 ? -1 : this.src.indexOf('}', open);
    this.pos = close === -1 ? this.src.length : close + 1;
  }
}
