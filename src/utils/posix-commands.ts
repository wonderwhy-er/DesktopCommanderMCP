/**
 * The command word of each command a POSIX shell (sh, bash, zsh) would run for
 * a script, quotes removed, in order. What the shell reads as data is skipped:
 * arguments, quoted text, heredoc bodies, comments, case patterns. A command
 * named by an expansion ($tool, $(which tool)) is left out: its name is only
 * known when the script runs. After an unquoted one the next word is read as a
 * command too: the expansion can leave no word.
 */
export function posixCommandWords(script: string): string[] {
  const scanner = new PosixScanner(script);
  scanner.list();
  return scanner.words;
}

// Reserved words, never command names. The next word can be a command: after one that ends a
// compound command (} fi done) bash allows only an operator there, and zsh's short forms a command.
// zsh adds always ({ ... } always { ... }) and the modifiers - noglob nocorrect, which run the next word
const RESERVED = new Set([
  '!', '{', '}', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'time', 'coproc',
  'always', '-', 'noglob', 'nocorrect',
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^=]*\])?\+?=/;
const ARRAY_ASSIGNMENT_START = /^[A-Za-z_][A-Za-z0-9_]*(\[[^=]*\])?\+?=$/;
const FILE_DESCRIPTOR = /^(\d+|\{[A-Za-z_][A-Za-z0-9_]*\})$/;
// coproc NAME is only allowed before a compound command, so a name with one after it names the coprocess
const COPROC_NAME = /^[ \t]+[A-Za-z_][A-Za-z0-9_]*(?=[ \t]*(?:\(|(?:\{|\[\[|if|while|until|for|select|case)(?=\s|$)))/;
// A loop variable after for, select or foreach
const LOOP_NAME = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)(?=[\s;(]|$)/;
const WORD_END = ' \t\n;&|<>()';
const ESCAPED_IN_DOUBLE_QUOTES = new Set(['$', '`', '"', '\\']);
const ANSI_C_ESCAPES = new Map([
  ['a', '\x07'], ['b', '\b'], ['e', '\x1b'], ['E', '\x1b'], ['f', '\f'], ['n', '\n'], ['r', '\r'], ['t', '\t'], ['v', '\v'],
  ['\\', '\\'], ["'", "'"], ['"', '"'], ['?', '?'],
]);
const ANSI_C_CODE = /^(?:x([0-9A-Fa-f]{1,2})|u([0-9A-Fa-f]{1,4})|U([0-9A-Fa-f]{1,8})|([0-7]{1,3})|c([\s\S]))/;

interface Word {
  value: string;
  // Some part was quoted or escaped: never a reserved word
  quoted: boolean;
  // Some part is an expansion: the value is only known at run time
  expanded: boolean;
}

interface Heredoc {
  delimiter: string;
  literal: boolean;
  stripTabs: boolean;
}

// Why list() returned: it read to the end, reached an unmatched ')' or '}', or ended a case item
type ListEnd = 'end' | 'paren' | 'brace' | 'case-item' | 'esac';

class PosixScanner {
  readonly words: string[] = [];
  private pos = 0;
  private heredocs: Heredoc[] = [];
  // How many $( ), <( ) or >( ) the current list is inside: only those end at an unmatched ')'
  private nesting = 0;
  // Reading ${ cmd; }: a '}' that no '{' in the list opened ends it
  private inBracedSubstitution = false;

  /**
   * closes: where the group opened at an index ends, shared with the probes this scanner
   * starts (see arithmeticAhead). A probe skips a group it already knows: nested $(( stays linear.
   */
  constructor(
    private readonly src: string,
    private readonly closes = new Map<number, number>(),
    private readonly probing = false,
  ) {}

  /**
   * Reads commands until the end of the script, an unmatched ')' (left unread),
   * the '}' of ${ cmd; }, or with `caseItem` the ';;' (left unread) or 'esac' of a case item.
   */
  list(caseItem = false): ListEnd {
    let atCommand = true;
    let afterTime = false;
    let subshells = 0;
    let braces = 0;
    // The subshell count before a '((' at a command: up to its '))' bash may read arithmetic
    let arithmeticFrom: number | undefined;
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === ' ' || c === '\t' || this.atCarriageReturnLineEnd()) {
        this.pos++;
        continue;
      }
      if (this.at('\\\n')) {
        this.pos += 2;
        continue;
      }
      if (c === '\n') {
        this.pos++;
        this.readHeredocBodies();
        atCommand = true;
        continue;
      }
      if (c === '#') {
        this.skipToLineEnd();
        continue;
      }
      if (c === ';') {
        if (caseItem && (this.at(';;') || this.at(';&'))) return 'case-item';
        this.pos++;
        atCommand = true;
        continue;
      }
      if (c === '&' || c === '|') {
        // && || |& read as two operators: the same commands either way. &> becomes & and >, which is
        // how dash reads it: the word after its target is a command there
        this.pos++;
        atCommand = true;
        continue;
      }
      if (c === '(') {
        if (atCommand) {
          // Also at '((': dash and ash read two subshells there, and bash does unless '))' closes it
          if (this.at('((')) arithmeticFrom ??= subshells;
          this.pos++;
          subshells++;
        } else {
          this.skipGroup(); // no command starts here: a zsh glob group or a syntax error
        }
        continue;
      }
      if (c === ')') {
        if (subshells === 0 && this.nesting > 0) return 'paren'; // closes the enclosing $( ), <( ) or >( )
        if (subshells > 0) subshells--;
        if (arithmeticFrom !== undefined && subshells <= arithmeticFrom) {
          arithmeticFrom = undefined;
          atCommand = true; // zsh runs a command after (( )): if (( x )) { cmd }
        }
        this.pos++; // still at a command: zsh's () { cmd } runs cmd, and in bash only an operator can follow
        continue;
      }
      if (arithmeticFrom !== undefined && this.at('<<')) {
        this.pos += 2; // a shift to bash, so no heredoc: the lines after it are commands bash runs
        continue;
      }
      if ((c === '<' || c === '>' || c === '=') && this.src[this.pos + 1] === '(') {
        this.pos += 2;
        this.substitution(); // process substitution; =( ) is zsh's
        atCommand = false;
        continue;
      }
      if (c === '<' || c === '>') {
        this.redirection();
        continue;
      }

      if (atCommand && this.at('!(')) {
        this.pos++; // '!' and then a subshell, not an extglob pattern
        continue;
      }
      if (atCommand && c === '}' && braces === 0 && this.inBracedSubstitution) {
        this.pos++; // ends ${ cmd; } also when a closing " follows straight away
        return 'brace';
      }

      const start = this.pos;
      const word = this.word();
      if (!atCommand) continue;

      const raw = this.src.slice(start, this.pos);
      const nextChar = this.src[this.pos];
      if (FILE_DESCRIPTOR.test(raw) && (nextChar === '<' || nextChar === '>')) continue; // 2>&1, {fd}>file
      if (ASSIGNMENT.test(raw)) continue; // VAR=value before the command
      if (afterTime && raw.startsWith('-')) continue; // time -p
      const reserved = word.quoted || word.expanded ? undefined : word.value;
      afterTime = reserved === 'time';
      if (reserved === 'esac' && caseItem) return 'esac';
      if (reserved === '{') braces++;
      if (reserved === '}') braces = Math.max(0, braces - 1);
      if (reserved === 'coproc') this.skipCoprocName();
      if (reserved !== undefined && RESERVED.has(reserved)) continue;
      if (reserved === 'case') {
        this.caseClause();
        continue;
      }
      if (reserved === 'for' || reserved === 'select') {
        atCommand = !this.loopHeaderHasWords(); // in WORDS: data up to the separator before 'do'
        continue;
      }
      // zsh's foreach NAME (WORDS) ... end and repeat COUNT cmd; to other shells they are commands
      if (reserved === 'foreach') {
        this.words.push(word.value);
        this.loopHeaderHasWords();
        continue;
      }
      if (reserved === 'repeat') {
        this.words.push(word.value);
        this.skipBlanks();
        this.word(); // the count
        continue;
      }
      if (reserved === 'function') {
        this.skipFunctionName(); // the body follows: still at a command
        continue;
      }
      if (reserved === '[[') {
        this.skipConditional(); // zsh's if [[ ... ]] { cmd } runs cmd: still at a command
        continue;
      }
      if (this.skipFunctionParens()) continue; // NAME () body: a definition, the body follows
      // An unquoted expansion can leave no word: $X sudo runs sudo when X is empty
      if (word.expanded && !word.quoted && word.value === '') continue;

      if (!word.expanded && word.value !== '') this.words.push(word.value);
      atCommand = false;
    }
    return 'end';
  }

  /** Reads text where only expansions run, as in a heredoc body with an unquoted delimiter */
  expansions(): void {
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === '\\') {
        this.pos += 2;
      } else if (c === '$') {
        this.dollar(true);
      } else if (c === '`') {
        this.backticks();
      } else {
        this.pos++;
      }
    }
  }

  private at(text: string): boolean {
    return this.src.startsWith(text, this.pos);
  }

  /** Reads one word, and the commands in its expansions; stops before a blank or an operator */
  private word(literal = false): Word {
    let value = '';
    let quoted = false;
    let expanded = false;
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === '(' && this.groupContinuesWord(value)) {
        value += this.skipGroup(); // extglob @(...) or an array assignment NAME=(...)
        continue;
      }
      if (WORD_END.includes(c) || this.atCarriageReturnLineEnd()) break;
      if (c === '\\') {
        if (this.src[this.pos + 1] !== '\n') {
          value += this.src[this.pos + 1] ?? '';
          quoted = true;
        }
        this.pos += 2;
        continue;
      }
      if (c === "'") {
        value += this.singleQuoted();
        quoted = true;
        continue;
      }
      if (c === '"') {
        const part = this.doubleQuoted(literal);
        value += part.value;
        expanded ||= part.expanded;
        quoted = true;
        continue;
      }
      if (c === '$' && !literal) {
        const part = this.dollar(false);
        value += part.value;
        expanded ||= part.expanded;
        quoted ||= part.quoted;
        continue;
      }
      if (c === '$' && literal && this.src[this.pos + 1] === "'") {
        this.pos++;
        value += this.ansiCQuoted(); // bash decodes $'...' even in a heredoc delimiter
        quoted = true;
        continue;
      }
      if (c === '$' && literal && this.src[this.pos + 1] === '"') {
        this.pos++; // and drops the $ of $"..."
        continue;
      }
      if (c === '`' && !literal) {
        this.backticks();
        expanded = true;
        continue;
      }
      value += c;
      this.pos++;
    }
    return { value, quoted, expanded };
  }

  // Git for Windows' bash reads a CRLF line end as a line end, so a command word ends before its \r
  private atCarriageReturnLineEnd(): boolean {
    return this.src[this.pos] === '\r' && (this.pos + 1 === this.src.length || this.src[this.pos + 1] === '\n');
  }

  private groupContinuesWord(value: string): boolean {
    return value !== '' && ('@!+*?'.includes(value[value.length - 1]) || ARRAY_ASSIGNMENT_START.test(value));
  }

  private singleQuoted(): string {
    const end = this.src.indexOf("'", this.pos + 1);
    const close = end === -1 ? this.src.length : end;
    const value = this.src.slice(this.pos + 1, close);
    this.pos = close + 1;
    return value;
  }

  private doubleQuoted(literal: boolean): { value: string; expanded: boolean } {
    let value = '';
    let expanded = false;
    this.pos++;
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === '"') {
        this.pos++;
        break;
      }
      if (c === '\\') {
        const next = this.src[this.pos + 1] ?? '';
        // Inside double quotes a backslash escapes only $ ` " \ and a newline
        if (next !== '\n') value += ESCAPED_IN_DOUBLE_QUOTES.has(next) ? next : `\\${next}`;
        this.pos += 2;
        continue;
      }
      if (c === '$' && !literal) {
        const part = this.dollar(true);
        value += part.value;
        expanded ||= part.expanded;
        continue;
      }
      if (c === '`' && !literal) {
        this.backticks();
        expanded = true;
        continue;
      }
      value += c;
      this.pos++;
    }
    return { value, expanded };
  }

  /** At '$': an expansion (whose commands are read), a $'...' or $"..." string, or a plain '$' */
  private dollar(inDoubleQuotes: boolean): { value: string; expanded: boolean; quoted: boolean } {
    const next = this.src[this.pos + 1];
    if (this.at('$((') && this.arithmeticAhead()) {
      this.pos++;
      this.skipGroup(); // arithmetic expansion
      return { value: '', expanded: true, quoted: false };
    }
    if (next === '(') {
      this.pos += 2;
      this.substitution();
      return { value: '', expanded: true, quoted: false };
    }
    if (next === '{' && ' \t\n|'.includes(this.src[this.pos + 2] ?? '')) {
      this.bracedSubstitution(); // ${ cmd; } and ${| cmd; }
      return { value: '', expanded: true, quoted: false };
    }
    if (next === '{') {
      this.parameterExpansion(inDoubleQuotes);
      return { value: '', expanded: true, quoted: false };
    }
    if (next === "'" && !inDoubleQuotes) {
      this.pos++;
      return { value: this.ansiCQuoted(), expanded: false, quoted: true };
    }
    if (next === '"' && !inDoubleQuotes) {
      this.pos++;
      return { ...this.doubleQuoted(false), quoted: true };
    }
    if (next !== undefined && /[A-Za-z_]/.test(next)) {
      this.pos += 2;
      while (this.pos < this.src.length && /[A-Za-z0-9_]/.test(this.src[this.pos])) this.pos++;
      return { value: '', expanded: true, quoted: false };
    }
    if (next !== undefined && /[0-9@*#?$!-]/.test(next)) {
      this.pos += 2;
      return { value: '', expanded: true, quoted: false };
    }
    this.pos++;
    return { value: '$', expanded: false, quoted: false };
  }

  // $'...' decoded as bash does: $'\x73udo' runs sudo. An unknown escape keeps its backslash, and a NUL ends it.
  private ansiCQuoted(): string {
    let value = '';
    this.pos++;
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === "'") {
        this.pos++;
        break;
      }
      if (c !== '\\') {
        value += c;
        this.pos++;
        continue;
      }
      const escaped = this.src[this.pos + 1] ?? '';
      const code = ANSI_C_CODE.exec(this.src.slice(this.pos + 1, this.pos + 10));
      if (code === null) {
        value += ANSI_C_ESCAPES.get(escaped) ?? `\\${escaped}`;
        this.pos += 2;
        continue;
      }
      const [text, hex, unicode, longUnicode, octal, control] = code;
      let point: number;
      if (control !== undefined) point = control.charCodeAt(0) & 0x1f;
      else if (octal !== undefined) point = parseInt(octal, 8) & 0xff;
      else point = Math.min(parseInt(hex ?? unicode ?? longUnicode, 16), 0x10ffff);
      value += String.fromCodePoint(point);
      this.pos += 1 + text.length;
    }
    return value.split('\0')[0];
  }

  /**
   * At '$((': whether it is arithmetic. Bash reads arithmetic only when the group the second
   * '(' opens is followed by ')'; otherwise $( starts a command substitution with a subshell.
   */
  private arithmeticAhead(): boolean {
    const probe = new PosixScanner(this.src, this.closes, true);
    probe.pos = this.pos + 2;
    probe.skipGroup();
    return this.src[probe.pos - 1] === ')' && this.src[probe.pos] === ')';
  }

  /** After '$(', '<(' or '>(': the commands up to the matching ')' */
  private substitution(): void {
    const open = this.pos - 1;
    const known = this.probing ? this.closes.get(open) : undefined;
    if (known !== undefined) {
      this.pos = known;
      return;
    }
    const outer = { heredocs: this.heredocs, braced: this.inBracedSubstitution };
    this.heredocs = [];
    this.inBracedSubstitution = false;
    this.nesting++;
    this.list();
    this.nesting--;
    this.heredocs = outer.heredocs;
    this.inBracedSubstitution = outer.braced;
    if (this.src[this.pos] === ')') this.pos++;
    this.closes.set(open, this.pos);
  }

  /** At '${' and a blank, a new line or '|': commands up to the '}' that ends them (bash 5.3, ksh93, mksh) */
  private bracedSubstitution(): void {
    this.pos += this.src[this.pos + 2] === '|' ? 3 : 2;
    const outer = { heredocs: this.heredocs, nesting: this.nesting, braced: this.inBracedSubstitution };
    this.heredocs = [];
    this.nesting = 0;
    this.inBracedSubstitution = true;
    this.list();
    this.heredocs = outer.heredocs;
    this.nesting = outer.nesting;
    this.inBracedSubstitution = outer.braced;
  }

  private backticks(): void {
    let body = '';
    this.pos++;
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === '`') {
        this.pos++;
        break;
      }
      const next = this.src[this.pos + 1];
      if (c === '\\' && next !== undefined && '$`\\'.includes(next)) {
        body += next;
        this.pos += 2;
        continue;
      }
      body += c;
      this.pos++;
    }
    this.words.push(...posixCommandWords(body));
  }

  // At '${': through the first '}' not quoted, escaped or in a nested expansion: a bare '{' doesn't
  // nest (${x:-{a}b} is {ab}). Single quotes in it quote, unless it is in double quotes.
  private parameterExpansion(inDoubleQuotes: boolean): void {
    this.pos += 2;
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === '\\') {
        this.pos += 2;
      } else if (c === "'" && !inDoubleQuotes) {
        this.singleQuoted();
      } else if (c === '"') {
        this.doubleQuoted(false);
      } else if (c === '$') {
        this.dollar(inDoubleQuotes);
      } else if (c === '`') {
        this.backticks();
      } else {
        this.pos++;
        if (c === '}') return;
      }
    }
  }

  /** Skips a ( ... ) group whose text is data, reading the commands in its expansions */
  private skipGroup(): string {
    const start = this.pos;
    const opens: number[] = [];
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === '\\') {
        this.pos += 2;
      } else if (c === "'") {
        this.singleQuoted();
      } else if (c === '"') {
        this.doubleQuoted(false);
      } else if (c === '$') {
        this.dollar(false);
      } else if (c === '`') {
        this.backticks();
      } else if (c === '(') {
        const known = this.probing ? this.closes.get(this.pos) : undefined;
        if (known === undefined) {
          opens.push(this.pos++);
          continue;
        }
        this.pos = known;
        if (opens.length === 0) break;
      } else {
        this.pos++;
        if (c === ')' && opens.length > 0) this.closes.set(opens.pop()!, this.pos);
        if (opens.length === 0) break;
      }
    }
    return this.src.slice(start, this.pos);
  }

  private redirection(): void {
    if (this.at('<<<')) {
      this.pos += 3;
      this.redirectTarget(); // a here-string: data, with its expansions
      return;
    }
    if (this.at('<<')) {
      const stripTabs = this.at('<<-');
      this.pos += stripTabs ? 3 : 2;
      this.skipBlanks();
      const delimiter = this.word(true);
      this.heredocs.push({ delimiter: delimiter.value, literal: delimiter.quoted, stripTabs });
      return;
    }
    this.pos++;
    if ('<>&|'.includes(this.src[this.pos] ?? ' ')) this.pos++; // >> >& >| <& <>
    this.redirectTarget();
  }

  private redirectTarget(): void {
    this.skipBlanks();
    if (this.at('<(') || this.at('>(')) {
      this.pos += 2;
      this.substitution();
      return;
    }
    this.word();
  }

  /** Heredoc bodies start after the line their << is on, in order */
  private readHeredocBodies(): void {
    for (const heredoc of this.heredocs) {
      const bodyStart = this.pos;
      let bodyEnd = this.src.length;
      while (this.pos < this.src.length) {
        const lineStart = this.pos;
        const newline = this.src.indexOf('\n', this.pos);
        const lineEnd = newline === -1 ? this.src.length : newline;
        const line = this.src.slice(lineStart, lineEnd);
        this.pos = newline === -1 ? lineEnd : lineEnd + 1;
        const candidate = (heredoc.stripTabs ? line.replace(/^\t+/, '') : line).replace(/\r$/, '');
        if (candidate === heredoc.delimiter) {
          bodyEnd = lineStart;
          break;
        }
      }
      // A quoted delimiter makes the body literal; otherwise only its expansions run
      if (!heredoc.literal) {
        const body = new PosixScanner(this.src.slice(bodyStart, bodyEnd));
        body.expansions();
        this.words.push(...body.words);
      }
    }
    this.heredocs = [];
  }

  private caseClause(): void {
    this.skipBlanks();
    this.word(); // the subject
    this.skipBlanksAndNewlines();
    this.word(); // 'in'
    while (this.pos < this.src.length) {
      this.skipBlanksAndNewlines();
      if (this.pos >= this.src.length || this.src[this.pos] === ')') return;
      if (this.src[this.pos] === '(') {
        this.pos++;
      } else {
        const first = this.word();
        if (!first.quoted && !first.expanded && first.value === 'esac') return;
      }
      this.skipPatterns();
      if (this.list(true) !== 'case-item') return;
      this.pos += this.at(';;&') ? 3 : 2;
    }
  }

  // The rest of a case item's patterns, through the ')' that ends them
  private skipPatterns(): void {
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === ')') {
        this.pos++;
        return;
      }
      if (c === '\n') return;
      const before = this.pos;
      if (c === ' ' || c === '\t' || c === '|') this.pos++;
      else this.word();
      if (this.pos === before) this.pos++;
    }
  }

  // [[ ... ]]: an expression, not commands; stops early at a line end or ';' if ']]' never comes
  private skipConditional(): void {
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === '\n' || c === ';') return;
      if (' \t()<>&|!'.includes(c) || this.atCarriageReturnLineEnd()) {
        this.pos++;
        continue;
      }
      const word = this.word();
      if (!word.quoted && word.value === ']]') return;
    }
  }

  private skipCoprocName(): void {
    const name = COPROC_NAME.exec(this.src.slice(this.pos, this.pos + 256));
    if (name) this.pos += name[0].length;
  }

  /**
   * After for or select: the header up to its body. True when `in WORDS` follows, which is data up to the
   * separator; otherwise the body comes next, also straight after do or { (for i do, for ((...)) {) and
   * after a ( ) group: bash's ((...)) or zsh's (WORDS) list.
   */
  private loopHeaderHasWords(): boolean {
    let name = LOOP_NAME.exec(this.src.slice(this.pos, this.pos + 256));
    while (name !== null && name[1] !== 'do') {
      this.pos += name[0].length;
      if (name[1] === 'in') return true;
      name = LOOP_NAME.exec(this.src.slice(this.pos, this.pos + 256));
    }
    this.skipBlanks();
    if (this.src[this.pos] === '(') this.skipGroup();
    return false;
  }

  private skipFunctionName(): void {
    this.skipBlanks();
    this.word();
    this.skipFunctionParens();
  }

  private skipFunctionParens(): boolean {
    const match = /^[ \t]*\([ \t]*\)/.exec(this.src.slice(this.pos, this.pos + 64));
    if (!match) return false;
    this.pos += match[0].length;
    return true;
  }

  private skipBlanks(): void {
    while (this.src[this.pos] === ' ' || this.src[this.pos] === '\t' || this.at('\\\n')) {
      this.pos += this.src[this.pos] === '\\' ? 2 : 1;
    }
  }

  private skipBlanksAndNewlines(): void {
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === '\n') {
        this.pos++;
        this.readHeredocBodies();
      } else if (c === ' ' || c === '\t' || this.atCarriageReturnLineEnd()) {
        this.pos++;
      } else if (c === '#') {
        this.skipToLineEnd();
      } else {
        return;
      }
    }
  }

  private skipToLineEnd(): void {
    const newline = this.src.indexOf('\n', this.pos);
    this.pos = newline === -1 ? this.src.length : newline;
  }
}
