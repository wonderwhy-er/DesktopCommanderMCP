import { seededRandom } from './posix-scripts.js';

/**
 * Generated PowerShell scripts, each with the exact set of command names in it.
 *
 * Scripts are nested from templates whose every slot is either a command position
 * or data. Each command the generator places has its own name (c0, c1, ...), so a
 * name inside data (a string, a here-string, a comment, a hashtable key, an
 * argument, a member name, a switch value) must never be reported, and one in a
 * command position always must. Data slots get whole generated scripts made inert
 * for that kind of quoting, so the data looks like commands.
 *
 * PowerShell's own parser finds the same names (see test-powershell-command-words.js),
 * which checks the expectations themselves. `powershell7` marks a script that uses
 * && or ||, which Windows PowerShell 5 can't parse.
 */
export function generatePowerShellScripts(seed, count) {
  const generator = new PowerShellScriptGenerator(seed);
  return Array.from({ length: count }, () => {
    generator.powershell7 = false;
    let { text, commands } = generator.command(4);
    // using must come first; it ends at ';' like any statement
    if (generator.random() < 0.1) text = `using namespace System.${generator.name()}; ${text}`;
    // Windows scripts end their lines with CRLF, which PowerShell reads as it reads LF
    if (generator.random() < 0.3) text = text.replace(/\r?\n/g, '\r\n');
    return { script: text, commands: [...new Set(commands)].sort(), powershell7: generator.powershell7 };
  });
}

// endsLine: the text ends in a comment or after --%, so nothing may follow it on its line
const node = (text, commands, endsLine = false) => ({ text, commands, endsLine });
const closed = (n) => (n.endsLine ? `& {${n.text}\n}` : n.text);
const both = (a, b) => [...a.commands, ...b.commands];

const noSingleQuotes = (t) => t.replace(/['‘’‚‛]/g, '');
const noDoubleQuoteSpecials = (t) => t.replace(/["“”„$`]/g, '');
// No '@' at all: a line can't start with the quote and @ that close a here-string
const noHereStringEnd = (t) => t.replace(/@/g, '');
const noHereStringEndOrExpansions = (t) => t.replace(/[@$`]/g, '');
const oneLine = (t) => t.replace(/[\r\n]/g, ' ');
const noBlockCommentEnd = (t) => t.replace(/[#>]/g, '');

// A command named c
const SIMPLE = [
  (c) => node(c, [c]),
  (c) => node(`${c} arg`, [c]),
  (c) => node(`${c} -Flag value -Switch:$true`, [c]),
  (c) => node(`& ${c}`, [c]),
  (c) => node(`& '${c}'`, [c]),
  (c) => node(`& "${c}" x`, [c]),
  (c) => node(`. ${c}`, [c]),
  (c) => node(`${c} 2>&1`, [c]),
  (c) => node(`${c} > $null`, [c]),
  (c) => node(`${c} @splat`, [c]),
  (c) => node(`${c} \`\n  -Continued x`, [c]),
  (c) => node(`${c} x,\n  y, z`, [c]),
  (c) => node(`${c} -Path "$env:TEMP\\x" -Size 1kb -Range 1..2`, [c]),
  (c) => node(`${c} @{ a = 1 } (1 + 2) $x.Name \`$y`, [c]),
  (c) => node(`${c}.exe /x`, [`${c}.exe`]),
  (c) => node(`\` ${c}`, [c]),
  // After --% the rest of the line, ; included, goes to the program as written
  (c, g) => node(`${c} --% raw ; ${g.name()}`, [c], true),
];

// A command or expression whose slots are only data: none of the c<n> in it is a command
const DATA = [
  (g) => node(`Write-Output '${g.data(noSingleQuotes)}'`, ['Write-Output']),
  (g) => node(`'${g.data(noSingleQuotes)}' | Out-Null`, ['Out-Null']),
  (g) => node(`Write-Output "${g.data(noDoubleQuoteSpecials)}"`, ['Write-Output']),
  (g) => node(`$t = @'\n${g.data(noHereStringEnd)}\n'@`, []),
  (g) => node(`@"\n${g.data(noHereStringEndOrExpansions)}\n"@ | Out-Null`, ['Out-Null']),
  (g) => node(`Write-Output 1 # ${g.data(oneLine)}\n`, ['Write-Output'], true),
  (g) => node(`<# ${g.data(noBlockCommentEnd)} #> Write-Output 1`, ['Write-Output']),
  (g) => node(`$h = [ordered]@{ Stage = 'a'; Operation = '${g.data(noSingleQuotes)}' }`, []),
  (g) => node(`$h = @{ ${g.name()} = 1; ${g.name()} = 'x' }`, []),
  (g) => node(`Write-Output ${g.name()} -Name ${g.name()}`, ['Write-Output']),
  (g) => node(`& $tool ${g.name()} --help`, []),
  (g) => node(`$x.${g.name()}($y).${g.name()}`, []),
  (g) => node(`[string]::${g.name()}`, []),
  (g) => node(`$base.OpenSubKey('${g.data(noSingleQuotes)}', $false)`, []),
  (g) => node(`switch (1) { ${g.name()} { } }`, []),
  (g) => node(`function ${g.name()} { }`, []),
  (g) => node(`enum E${g.next} { ${g.name()}; ${g.name()} = 2 }`, []),
  // An escaped $ starts no subexpression; '' is one quote; ${name} is a variable
  (g) => node(`Write-Output "\`$(${g.name()}) \`"x\`" ${'$'}{${g.name()}}: $x"`, ['Write-Output']),
  (g) => node(`$re = 'it''s $(${g.name()})'`, []),
  (g) => node(`$p = "\${env:ProgramFiles(x86)}\\${g.name()}"`, []),
  (g) => node(`$v = $x."${g.name()}".$y`, []),
  (g) => node(`$h = @{ "Time (${g.name()})" = 1; '${g.name()}' = $i+=$j }`, []),
  (g) => node(`$re = "\\\\/([a-z${g.name()}]+)(:[\`'].+?)?"`, []),
  (g) => node(`$codes = @(0, 3010)  # http://x/${g.name()}(VS.85).aspx\n`, [], true),
  (g) => node(`$sb = [scriptblock]::Create('${g.data(noSingleQuotes)}')`, []),
  (g) => node(`& "$env:ProgramFiles\\${g.name()}.exe" a`, []),
];

// A statement with commands inside
const COMPOUND = [
  (g, d) => { const a = g.command(d), b = g.command(d); return node(`${closed(a)}; ${b.text}`, both(a, b), b.endsLine); },
  (g, d) => { const a = g.command(d), b = g.command(d); return node(`${a.text}\n${b.text}`, both(a, b), b.endsLine); },
  (g) => { const a = g.simple(), b = g.simple(); return node(`${closed(a)} | ${b.text}`, both(a, b), b.endsLine); },
  (g, d) => { const a = g.command(d), b = g.simple(); return node(`$(${a.text}\n) | ${b.text}`, both(a, b), b.endsLine); },
  (g) => { const a = g.simple(), b = g.simple(); g.powershell7 = true; return node(`${closed(a)} && ${b.text}`, both(a, b), b.endsLine); },
  (g) => { const a = g.simple(), b = g.simple(); g.powershell7 = true; return node(`${closed(a)} || ${b.text}`, both(a, b), b.endsLine); },
  (g, d) => { const a = g.pipeline(d), b = g.command(d); return node(`if (${a.text}) { ${b.text}\n}`, both(a, b)); },
  (g, d) => {
    const a = g.pipeline(d), b = g.command(d), c = g.command(d);
    return node(`if ($false) { }\nelseif (${a.text}) { ${b.text}\n}\nelse { ${c.text}\n}`, [...both(a, b), ...c.commands]);
  },
  (g, d) => { const a = g.pipeline(d), b = g.command(d); return node(`while (${a.text}) { ${b.text}\n}`, both(a, b)); },
  (g, d) => { const a = g.command(d), b = g.pipeline(d); return node(`do { ${a.text}\n} until (${b.text})`, both(a, b)); },
  (g, d) => { const a = g.pipeline(d), b = g.command(d); return node(`for (${a.text}; $i -lt 1; $i++) { ${b.text}\n}`, both(a, b)); },
  (g, d) => { const a = g.pipeline(d), b = g.command(d); return node(`foreach ($i in ${a.text}) { ${b.text}\n}`, both(a, b)); },
  (g, d) => { const a = g.command(d); return node(`:outer foreach ($i in 1..2) { ${a.text}\n}`, a.commands); },
  (g, d) => { const a = g.pipeline(d), b = g.command(d); return node(`switch (${a.text}) { default { ${b.text}\n} }`, both(a, b)); },
  (g, d) => { const a = g.command(d); return node(`switch -regex ('x') { 'x' { ${a.text}\n} }`, a.commands); },
  (g, d) => {
    const a = g.command(d), b = g.command(d);
    return node(`switch -regex ($x) {\n'^a' { ${a.text}\n}\ndefault { ${b.text}\n}\n}`, both(a, b));
  },
  (g, d) => {
    const a = g.command(d), b = g.command(d);
    return node(`if ($x) { ${a.text}\n}\n# a note\nelse { ${b.text}\n}`, both(a, b));
  },
  (g, d) => {
    const a = g.command(d), b = g.command(d);
    return node(`@(1, 2) | % { ${a.text}\n} | ? { ${b.text}\n}`, ['%', '?', ...both(a, b)]);
  },
  (g, d) => {
    const a = g.command(d), b = g.command(d);
    return node(`$h = @{ 'k' = if ($x) { ${a.text}\n} else { ${b.text}\n}; "Time (ms)" = 1 }`, both(a, b));
  },
  (g, d) => { const a = g.command(d); return node(`$p = [System.IO.Path]::Combine('a', $(${a.text}\n))`, a.commands); },
  (g, d) => { const a = g.command(d); return node(`$x.Method($(${a.text}\n), [ref]$y)`, a.commands); },
  (g, d) => { const a = g.command(d); return node(`Write-Output "$($x.Name) $(${a.text}\n)"`, ['Write-Output', ...a.commands]); },
  (g, d) => {
    const a = g.command(d), c = g.simple();
    return node(`Write-Output @"\n$(@'\n${g.data(noHereStringEnd)}\n'@ | ${c.text}\n)\n$(${a.text}\n)\n"@`, ['Write-Output', ...c.commands, ...a.commands]);
  },
  (g, d) => { const a = g.command(d); return node(`trap [Exception] { ${a.text}\n}`, a.commands); },
  (g, d) => { const a = g.command(d); return node(`$sb = { param($x) ${a.text}\n}`, a.commands); },
  (g, d) => {
    const a = g.command(d), b = g.command(d), c = g.command(d);
    return node(`& { begin { ${a.text}\n} process { ${b.text}\n} end { ${c.text}\n} }`, [...both(a, b), ...c.commands]);
  },
  (g, d) => { const a = g.pipeline(d); return node(`$script:x = ${a.text}`, a.commands); },
  (g, d) => { const a = g.simple(); return node(`if (-not (${closed(a)})) { }`, a.commands); },
  (g, d) => { const a = g.command(d); return node(`return $(${a.text}\n)`, a.commands); },
  (g, d) => { const a = g.command(d); return node(`throw "failed: $(${a.text}\n)"`, a.commands); },
  (g, d) => {
    const a = g.command(d), b = g.command(d);
    return node(`function ${g.name()} {\n[CmdletBinding()]\n[OutputType([string])]\nparam(\n[Parameter(Mandatory = $true, Position = 0)]\n[ValidateSet('a', 'b')]\n[string] $p = $(${a.text}\n),\n[parameter (Position=1, ValueFromPipelineByPropertyName=$true)] $q\n)\n${b.text}\n}`, both(a, b));
  },
  (g, d) => {
    const a = g.command(d), b = g.command(d);
    return node(`function ${g.name()} {\nParam\n(\n$p = $(${a.text}\n)\n)\n${b.text}\n}`, both(a, b));
  },
  (g, d) => { const a = g.command(d); return node(`function ${g.name()} {\ndynamicparam { ${a.text}\n}\nbegin { }\n}`, a.commands); },
  (g) => {
    const c = g.name(), k = `K${g.next++}`;
    return node(`class ${k} {\n[string] $p = 'x'\nhidden static [int] $n = 1\n${k}() { ${c} arg\n}\n[void] M() { }\n}`, [c]);
  },
  (g) => node('data { ConvertFrom-StringData "a = b" }', ['ConvertFrom-StringData']),
  (g, d) => {
    const a = g.command(d), b = g.command(d), c = g.command(d);
    // A return directly in finally is a parse error; in a script block run there it is not
    return node(`try { ${a.text}\n}\ncatch [System.Exception] { ${b.text}\n}\nfinally { . {\n${c.text}\n} }`, [...both(a, b), ...c.commands]);
  },
  (g, d) => { const a = g.command(d); return node(`trap { ${a.text}\n}`, a.commands); },
  (g, d) => { const a = g.command(d); return node(`function ${g.name()} { ${a.text}\n}`, a.commands); },
  (g, d) => { const a = g.command(d), b = g.command(d); return node(`function ${g.name()}($p = $(${a.text}\n)) { ${b.text}\n}`, both(a, b)); },
  (g, d) => { const a = g.command(d), b = g.command(d); return node(`function ${g.name()} {\nparam($p = $(${a.text}\n))\n${b.text}\n}`, both(a, b)); },
  (g, d) => { const a = g.command(d), b = g.command(d); return node(`filter ${g.name()} { begin { ${a.text}\n} process { ${b.text}\n} }`, both(a, b)); },
  (g, d) => { const a = g.command(d); return node(`& { ${a.text}\n}`, a.commands); },
  (g, d) => { const a = g.command(d); return node(`. { ${a.text}\n}`, a.commands); },
  (g, d) => { const a = g.pipeline(d); return node(`$x = ${a.text}`, a.commands); },
  (g, d) => { const a = g.pipeline(d); return node(`$x += ${a.text}`, a.commands); },
  (g, d) => { const a = g.pipeline(d), b = g.command(d); return node(`$x = if (${a.text}) { ${b.text}\n}`, both(a, b)); },
  (g, d) => { const a = g.command(d); return node(`$x = @(${a.text}\n)`, a.commands); },
  (g, d) => { const a = g.command(d); return node(`[void]$(${a.text}\n)`, a.commands); },
  (g, d) => { const a = g.command(d); return node(`($(${a.text}\n)).Count`, a.commands); },
  (g, d) => { const a = g.pipeline(d); return node(`$h = @{ Key = ${a.text}; Other = 'x' }`, a.commands); },
  (g, d) => { const a = g.pipeline(d); return node(`$h = @{ (${a.text}) = 1 }`, a.commands); },
  (g, d) => { const a = g.command(d); return node(`Write-Output "now: $(${a.text}\n)"`, ['Write-Output', ...a.commands]); },
  (g, d) => {
    const a = g.command(d);
    return node(`Write-Output @"\n${g.data(noHereStringEndOrExpansions)}\n$(${a.text}\n)\n"@`, ['Write-Output', ...a.commands]);
  },
  (g, d) => { const a = g.command(d); return node(`Invoke-Command { ${a.text}\n}`, ['Invoke-Command', ...a.commands]); },
  (g, d) => { const a = g.command(d), c = g.name(); return node(`${c} -ScriptBlock { ${a.text}\n}`, [c, ...a.commands]); },
  (g, d) => { const a = g.command(d); return node(`$sb = { ${a.text}\n}`, a.commands); },
  (g, d) => { const a = g.command(d), c = g.name(); return node(`${c} $(${a.text}\n) -Name x`, [c, ...a.commands]); },
  (g, d) => { const a = g.pipeline(d), c = g.name(); return node(`${c} (${a.text})`, [c, ...a.commands]); },
  // A class method may only use variables it assigns, so it gets a plain command
  (g) => { const c = g.name(); return node(`class K${g.next++} { [void] M() { ${c} arg\n} }`, [c]); },
];

class PowerShellScriptGenerator {
  constructor(seed) {
    this.random = seededRandom(seed);
    this.next = 0;
    this.powershell7 = false;
  }

  pick(list) {
    return list[Math.floor(this.random() * list.length)];
  }

  name() {
    return `c${this.next++}`;
  }

  /** A command that can be a pipeline element */
  simple() {
    return this.pick(SIMPLE)(this.name(), this);
  }

  command(depth) {
    const roll = this.random();
    if (depth <= 0 || roll < 0.3) return this.simple();
    if (roll < 0.5) return this.pick(DATA)(this);
    return this.pick(COMPOUND)(this, depth - 1);
  }

  /** A pipeline: in a condition, after = or in a hashtable value */
  pipeline(depth) {
    const roll = this.random();
    if (depth <= 0 || roll < 0.5) {
      const a = this.simple();
      return a.endsLine ? node(`$(${a.text}\n)`, a.commands) : a;
    }
    const a = this.command(depth - 1);
    return node(roll < 0.8 ? `$(${a.text}\n)` : `@(${a.text}\n)`, a.commands);
  }

  /** A generated script made only data where it is put: `clean` takes out what would end or escape it */
  data(clean) {
    return clean(this.command(2).text);
  }
}
