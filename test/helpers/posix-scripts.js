/**
 * Generated POSIX shell scripts, each with the exact set of commands it runs.
 *
 * Scripts are nested from templates whose every slot is either a command position
 * or data. Each command the generator places has its own name (c0, c1, ...), so a
 * name inside data (quotes, a quoted heredoc body, a comment, a case pattern, an
 * argument) must never be reported, and one in a command position always must.
 * Data slots get whole generated scripts made inert for that kind of quoting, so
 * the data looks like commands, as a heredoc of Python or SQL does.
 *
 * Given commands that succeed, every command position in a script also runs: a
 * real shell running it with each c<n> recording its name runs exactly the
 * expected c<n>, which checks the expectations themselves.
 */
export function generatePosixScripts(seed, count) {
  const generator = new PosixScriptGenerator(seed);
  return Array.from({ length: count }, () => {
    const { text, commands } = generator.command(4);
    return { script: text, commands: [...new Set(commands)].sort() };
  });
}

/** A seeded pseudo-random number generator (mulberry32): the same seed, the same scripts */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// endsLine: the text ends with a heredoc body or a comment, so nothing may follow it on its line
const node = (text, commands, endsLine = false) => ({ text, commands, endsLine });
// A command that something can follow on the same line
const closed = (n) => (n.endsLine ? `{ ${n.text}}` : n.text);
const both = (a, b) => [...a.commands, ...b.commands];
// A command put right after an opening parenthesis: '((' and '$((' read differently, and bash
// fails on a third '(' straight after '((' when the group spans lines
const spaced = (n) => (n.text.startsWith('(') ? ` ${n.text}` : n.text);

const noSingleQuote = (t) => t.replace(/'/g, '');
const noDoubleQuoteSpecials = (t) => t.replace(/[$`"\\]/g, '');
const noExpansions = (t) => t.replace(/[$`\\]/g, '');
const oneLine = (t) => t.replace(/[\r\n]/g, ' ');
const asIs = (t) => t;
// Text bound to lines (a heredoc, a comment), which bash's parenthesis matching does not know about
const lineBound = (template) => Object.assign(template, { lineBound: true });

// A simple command named c
const SIMPLE = [
  (c) => node(c, [c]),
  (c) => node(`${c} arg`, [c]),
  (c) => node(`"${c}"`, [c]),
  (c) => node(`\\${c}`, [c]),
  (c) => node(`${c[0]}""${c.slice(1)}`, [c]),
  (c) => node(`X=1 ${c}`, [c]),
  (c) => node(`2>/dev/null ${c}`, [c]),
  (c) => node(`${c} 2>&1 >/dev/null`, [c]),
  (c) => node(`0</dev/null ${c} &>/dev/null`, [c]),
  (c) => node(`${c} &>>/dev/null 4>&1 >|/dev/null`, [c]),
  (c) => node(`${c} \\\n  arg`, [c]),
  (c) => node(`\\\n  ${c}`, [c]),
  (c) => node(`${c[0]}\\\n${c.slice(1)}`, [c]),
  (c) => node(`\t${c}\targ`, [c]),
  (c) => node(`${c[0]}''${c.slice(1)}`, [c]),
  (c) => node(`${c}>/dev/null`, [c]),
  (c) => node(`${c} >\t/dev/null`, [c]),
  // A redirection before the name: its target is not the command
  (c) => node(`2>&1 ${c}`, [c]),
  (c) => node(`> /dev/null ${c}`, [c]),
  (c, g) => node(`<<< ${g.name()} ${c}`, [c]),
  (c, g) => node(`${c} <<< ${g.name()}`, [c]),
  // ANSI-C escapes in the name: $'\x63' is c
  (c, g) => node(`$'${g.pick(['\\x63', '\\143', '\\u0063', '\\U00000063', 'c'])}${c.slice(1)}'`, [c]),
  (c) => node(`$"${c}"`, [c]),
  lineBound((c, g) => { const d = g.delimiter(); return node(`${c} <<'${d}'\n${g.data(asIs)}\n${d}\n`, [c], true); }),
  lineBound((c, g) => { const d = g.delimiter(); return node(`${c} <<${d}\n${g.data(noExpansions)}\n${d}\n`, [c], true); }),
  lineBound((c, g) => { const d = g.delimiter(); return node(`<< '${d}' ${c}\n${g.data(asIs)}\n${d}\n`, [c], true); }),
];

// A command whose slots are only data: none of the c<n> in it runs
const DATA = [
  (g) => node(`: '${g.data(noSingleQuote)}'`, [':']),
  (g) => node(`: "${g.data(noDoubleQuoteSpecials)}"`, [':']),
  (g) => node(`: $'${g.data((t) => t.replace(/['\\]/g, ''))}'`, [':']),
  lineBound((g) => { const d = g.delimiter(); return node(`: <<'${d}'\n${g.data(asIs)}\n${d}\n`, [':'], true); }),
  lineBound((g) => { const d = g.delimiter(); return node(`: <<\\${d}\n${g.data(asIs)}\n${d}\n`, [':'], true); }),
  lineBound((g) => { const d = g.delimiter(); return node(`: <<-"${d}"\n\t${g.data(asIs)}\n\t${d}\n`, [':'], true); }),
  lineBound((g) => { const d = g.delimiter(); return node(`: <<${d}\n${g.data(noExpansions)}\n${d}\n`, [':'], true); }),
  lineBound((g) => node(`: # ${g.data(oneLine)}\n`, [':'], true)),
  (g) => node(`case ${g.name()} in ${g.pattern('x')} :;; esac`, [':']),
  (g) => node(`case x in ${g.pattern(`${g.name()}|y`)} :;; esac`, [':']),
  (g) => node(`for i in ${g.name()} 1; do :; done`, [':']),
  (g) => node(`: \${${g.variable()}:-${g.name()}}`, [':']),
  // Outside double quotes, single quotes in ${ } quote
  (g) => node(`: \${${g.variable()}:-'${g.data(noSingleQuote)}'}`, [':']),
  (g) => node(`: \${${g.variable()}:-"}${g.name()}"}`, [':']),
  (g) => node(`X=${g.name()} :`, [':']),
  (g) => node(`: ${g.name()} ${g.name()}`, [':']),
  (g) => node(`[[ ${g.name()} != x ]]`, []),
  (g) => node(`${g.functionName()}() { :; }`, [':']),
];

// A command with commands inside
const COMPOUND = [
  (g, d) => { const a = g.command(d), b = g.command(d); return node(`${closed(a)}; ${b.text}`, both(a, b), b.endsLine); },
  (g, d) => { const a = g.command(d), b = g.command(d); return node(`${a.text}\n${b.text}`, both(a, b), b.endsLine); },
  (g, d) => { const a = g.command(d), b = g.command(d); return node(`${closed(a)} && ${b.text}`, both(a, b), b.endsLine); },
  (g, d) => { const a = g.command(d), b = g.simple(); return node(`${closed(a)} | ${b.text}`, both(a, b), b.endsLine); },
  // Right of a pipe, time and ! are plain words and a function defined lives only in that subshell
  (g, d) => { const a = g.command(d), b = g.command(d); return node(`${closed(a)} | { ${b.text}\n}`, both(a, b)); },
  (g, d) => { const a = g.command(d), b = g.command(d); return node(`${closed(a)} &\nwait\n${b.text}`, [...both(a, b), 'wait'], b.endsLine); },
  (g, d) => { const b = g.command(d); return node(`false || ${b.text}`, ['false', ...b.commands], b.endsLine); },
  (g, d) => { const a = g.command(d); return node(`( ${a.text}\n)`, a.commands); },
  // '((' would be arithmetic to bash
  (g, d) => { const a = g.command(d); return node(a.text.startsWith('(') ? `( ${closed(a)})` : `(${closed(a)})`, a.commands); },
  (g, d) => { const a = g.command(d); return node(`{ ${a.text}\n} 2>/dev/null`, a.commands); },
  (g, d) => { const a = g.command(d); return node(`{ ! { ${a.text}\n}; } || :`, [...a.commands, ':']); },
  (g, d) => { const a = g.parenMatchedCommand(d); return node(`{ !( ${a.text}\n); } || :`, [...a.commands, ':']); },
  (g, d) => { const a = g.parenMatchedCommand(d); return node(`((${spaced(a)}\n) )`, a.commands); },
  // time is a reserved word only where a pipeline starts, so it is never a pipe's right side
  (g) => { const a = g.simple(); return node(`time ${g.pick(['', '-p '])}${closed(a)}`, a.commands); },
  // A backslash in double quotes stays unless it escapes $ ` " \ : these names don't exist, so || :
  (g) => { const c = g.name(); return node(`{ "\\${c}" || :; }`, [`\\${c}`, ':']); },
  (g) => { const c = g.name(); return node(`{ "${c}\\\\" || :; }`, [`${c}\\`, ':']); },
  (g) => { const c = g.name(); return node(`{ "${c}\\$\\\`\\"" || :; }`, [`${c}$\`"`, ':']); },
  (g, d) => { const a = g.command(d); return node(`time { ${a.text}\n}`, a.commands); },
  (g, d) => { const a = g.command(d), b = g.command(d); return node(`if ${a.text}\nthen ${b.text}\nfi`, both(a, b)); },
  (g, d) => { const a = g.command(d), b = g.command(d); return node(`if false; then :\nelif ${a.text}\nthen ${b.text}\nfi`, ['false', ':', ...both(a, b)]); },
  (g, d) => { const a = g.command(d); return node(`if false; then :\nelse ${a.text}\nfi`, ['false', ':', ...a.commands]); },
  (g, d) => { const a = g.command(d); return node(`while ${closed(a)}; do break; done`, [...a.commands, 'break']); },
  (g, d) => { const a = g.command(d); return node(`for i in 1; do ${a.text}\ndone`, a.commands); },
  (g, d) => { const a = g.command(d); return node(`for ((i = 0; i < 1; i++)); do ${a.text}\ndone`, a.commands); },
  (g, d) => { const a = g.command(d); return node(`case x in ${g.pattern('x')} ${a.text}\nesac`, a.commands); },
  (g, d) => { const a = g.command(d), b = g.command(d); return node(`case x in ${g.pattern('x')} ${a.text}\n;& ${g.pattern('y')} ${b.text}\n;; esac`, both(a, b)); },
  (g, d) => { const a = g.command(d), b = g.command(d); return node(`case x in ${g.pattern('x')} ${a.text}\n;;& ${g.pattern('*')} ${b.text}\n;; esac`, both(a, b)); },
  (g, d) => { const a = g.command(d), b = g.simple(); return node(`${closed(a)} |& ${b.text}`, both(a, b), b.endsLine); },
  (g, d) => { const a = g.command(d); return node(`coproc { ${a.text}\n}\nwait`, [...a.commands, 'wait']); },
  (g, d) => { const a = g.command(d); return node(`until ${closed(a)}; do break; done`, [...a.commands, 'break']); },
  (g, d) => { const a = g.command(d); return node(`case x in ${g.pattern('x')} ${a.text}\n;; esac`, a.commands); },
  (g, d) => { const a = g.command(d); return node(`case x in\n(x) ${a.text}\n;;\nesac`, a.commands); },
  (g, d) => { const a = g.command(d); return node(`case x in ${g.pattern('y | z')} :;; ${g.pattern('x')} ${a.text}\n;; esac`, [':', ...a.commands]); },
  (g, d) => { const a = g.command(d); return node(`case x in\n\t${g.pattern('x')}\t${a.text}\n\t;;\nesac`, a.commands); },
  lineBound((g, d) => { const a = g.command(d); return node(`case x in\n# ${g.data(oneLine)}\n${g.pattern('x')} ${a.text}\n;; esac`, a.commands); }),
  (g, d) => { const a = g.command(d), f = g.functionName(); return node(`${f}() { ${a.text}\n}\n${f}`, [...a.commands, f]); },
  (g, d) => { const a = g.command(d), f = g.functionName(); return node(`${f}() ( ${a.text}\n)\n${f}`, [...a.commands, f]); },
  (g, d) => { const a = g.command(d), f = g.functionName(); return node(`function ${f} {\n${a.text}\n}\n${f}`, [...a.commands, f]); },
  (g, d) => { const a = g.command(d), f = g.functionName(); return node(`function ${f} () {\n${a.text}\n}\n${f}`, [...a.commands, f]); },
  // After $( or <( a leading '(' is spaced: '$((' and '<((' read differently
  (g, d) => { const a = g.command(d); return node(`: $(${spaced(a)}\n)`, [':', ...a.commands]); },
  (g, d) => { const a = g.command(d); return node(`: "$(${spaced(a)}\n)"`, [':', ...a.commands]); },
  (g, d) => { const a = g.parenMatchedCommand(d); return node(`: $((${spaced(a)}\n) )`, [':', ...a.commands]); },
  (g, d) => { const a = g.parenMatchedCommand(d); return node(`: $(( 0$(${spaced(a)}\n) ))`, [':', ...a.commands]); },
  (g, d) => { const a = g.parenMatchedCommand(d); return node(`: \${${g.variable()}:-$(${spaced(a)}\n)}`, [':', ...a.commands]); },
  (g, d) => { const a = g.parenMatchedCommand(d); return node(`: "\${${g.variable()}:-$(${spaced(a)}\n)}"`, [':', ...a.commands]); },
  // An escaped } does not end ${ }
  (g, d) => { const a = g.parenMatchedCommand(d); return node(`: \${${g.variable()}:-\\}$(${spaced(a)}\n)}`, [':', ...a.commands]); },
  (g) => { const c = g.name(); return node(`: \${${g.variable()}:-\`${c}\`}`, [':', c]); },
  (g, d) => { const a = g.parenMatchedCommand(d), c = g.name(); return node(`${c} < <(${spaced(a)}\n)`, [c, ...a.commands]); },
  (g, d) => { const a = g.parenMatchedCommand(d); return node(`: <(${spaced(a)}\n)`, [':', ...a.commands]); },
  (g, d) => { const a = g.command(d); return node(`[[ -z $(${spaced(a)}\n) ]]`, a.commands); },
  (g, d) => {
    const a = g.command(d), b = g.command(d);
    // x > y is false, so || goes on to the second $( )
    return node(`[[ -z $(${spaced(a)}\n) && ( x > y || ! -n "$(${spaced(b)}\n)" ) ]]`, both(a, b));
  },
  (g, d) => { const a = g.command(d); return node(`: <<< "$(${spaced(a)}\n)"`, [':', ...a.commands]); },
  (g, d) => { const a = g.command(d); return node(`: <<<$(${spaced(a)}\n)`, [':', ...a.commands]); },
  (g, d) => { const a = g.parenMatchedCommand(d); return node(`: >(${spaced(a)}\n)`, [':', ...a.commands]); },
  // In double quotes a single quote in ${ } is a plain character
  (g, d) => { const a = g.parenMatchedCommand(d); return node(`: "\${${g.variable()}:-'$(${spaced(a)}\n)'}"`, [':', ...a.commands]); },
  (g, d) => { const a = g.command(d); return node(`${g.variable()}=$(${spaced(a)}\n)`, a.commands); },
  (g, d) => { const a = g.command(d), c = g.name(); return node(`${g.variable()}=$(${spaced(a)}\n) ${c}`, [...a.commands, c]); },
  (g, d) => { const a = g.parenMatchedCommand(d); return node(`${g.variable()}=(1 $(${spaced(a)}\n))`, a.commands); },
  // Quoted parentheses don't end an array (bash refuses an escaped one inside $( ))
  (g, d) => {
    const a = g.parenMatchedCommand(d), c = g.name();
    return node(`${g.variable()}=(")" '(' "$(${spaced(a)}\n)" \`${c}\`)`, [...a.commands, c]);
  },
  (g) => { const c = g.name(); return node(`: \`${c}\``, [':', c]); },
  (g) => { const c = g.name(); return node(`: "\`${c}\`"`, [':', c]); },
  (g) => { const c = g.name(); return node(`: \`: \\\`${c}\\\`\``, [':', c]); },
  lineBound((g, d) => {
    const a = g.parenMatchedCommand(d), delimiter = g.delimiter();
    return node(`: <<${delimiter}\n${g.data(noExpansions)}\n$(${a.text}\n)\n${delimiter}\n`, [':', ...a.commands], true);
  }),
  // In an unquoted heredoc body \$ is a plain $, $' is no quote, and backticks run
  lineBound((g, d) => {
    const a = g.parenMatchedCommand(d), data = g.name(), c = g.name(), delimiter = g.delimiter();
    return node(`: <<${delimiter}\n\\$(${data}) $'$(${spaced(a)}\n)'\n\`${c}\`\n${delimiter}\n`, [':', ...a.commands, c], true);
  }),
];

class PosixScriptGenerator {
  constructor(seed) {
    this.random = seededRandom(seed);
    this.next = 0;
    this.parenMatched = 0;
  }

  /**
   * A command in text bash finds the end of by matching brackets: (( ... ) ), $(( ... ) ),
   * ${ ... }, NAME=( ), <( ), !( ) and $( ) in a heredoc body. A case pattern's lone ')'
   * would end it early, and bash runs the lines of a heredoc inside (( ... ) ) as commands,
   * so neither is generated there.
   */
  parenMatchedCommand(depth) {
    this.parenMatched++;
    const command = this.command(depth);
    this.parenMatched--;
    return command;
  }

  pattern(text) {
    return this.parenMatched > 0 ? `(${text})` : `${text})`;
  }

  pick(list) {
    const usable = this.parenMatched > 0 ? list.filter((template) => !template.lineBound) : list;
    return usable[Math.floor(this.random() * usable.length)];
  }

  name() {
    return `c${this.next++}`;
  }

  functionName() {
    return `f${this.next++}`;
  }

  delimiter() {
    return `D${this.next++}`;
  }

  // Its own variable: one set earlier would skip the default in ${v:-...}
  variable() {
    return `v${this.next++}`;
  }

  simple() {
    return this.pick(SIMPLE)(this.name(), this);
  }

  command(depth) {
    const roll = this.random();
    if (depth <= 0 || roll < 0.3) return this.simple();
    if (roll < 0.5) return this.pick(DATA)(this);
    return this.pick(COMPOUND)(this, depth - 1);
  }

  /** A generated script made only data where it is put: `clean` takes out what would end or escape it */
  data(clean) {
    return clean(this.command(2).text);
  }
}
