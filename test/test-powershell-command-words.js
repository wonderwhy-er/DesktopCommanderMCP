/**
 * powershellCommandWords finds every command name in a PowerShell script, and
 * nothing PowerShell reads as data. Checked three ways:
 * - the commands from the bug reports, and the forms a shell-blind scanner reads wrong
 * - generated scripts whose answer is known by construction (helpers/powershell-scripts.js)
 * - when PowerShell is installed, its own parser reads every one of them and must find
 *   the same names, which checks the answers themselves
 */
import assert from 'assert';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { powershellCommandWords } from '../dist/utils/powershell-commands.js';
import { resolveShellPath } from '../dist/utils/shell.js';
import { generatePowerShellScripts } from './helpers/powershell-scripts.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

// Each case: a script, and the names of the commands in it, as written. They hold in both editions,
// or only in PowerShell 7 (powershell7) or Windows PowerShell 5 (powershell5). PowerShell parses a
// windowsOnly case only on Windows, so only there is it compared with the parser.
export const CASES = [
  // Data is not a command
  { name: 'a hashtable value', script: "$metadata = [ordered]@{ Stage='preflight'; Operation='Device init then read-only health check' }; $metadata | ConvertTo-Json", commands: ['ConvertTo-Json'] },
  { name: 'Python in a here-string', script: "$text = @'\nre.search(r'(?i)(password|passwd|secret)', value)\n'@\nWrite-Output $text", commands: ['Write-Output'] },
  { name: 'C++ in a here-string piped to a file', script: "@'\nstd::string s = std::format(\"{}\", x);\n'@ | Set-Content main.cpp", commands: ['Set-Content'] },
  { name: 'backticks in single quotes', script: "Write-Output '`suDo`'", commands: ['Write-Output'] },
  { name: 'typographic quotes', script: 'Write-Output \u2018format c:\u2019', commands: ['Write-Output'] },
  { name: 'method arguments', script: "$base.OpenSubKey('SOFTWARE\\Microsoft\\NET Framework Setup')", commands: [] },
  { name: 'a comment', script: 'Get-Date # format later', commands: ['Get-Date'] },
  { name: 'a command called through a variable', script: '& $client init --help', commands: [] },
  { name: 'a $ in a command name is text: nothing in it runs', script: 'format$null C:; a$(shutdown) x; sh"u$(reboot)"', commands: ['format$null', 'a$(shutdown)', 'shu$(reboot)'] },
  { name: 'a $( ) in an argument runs', script: 'Write-Output a$(shutdown)', commands: ['Write-Output', 'shutdown'] },
  { name: 'dot-sourcing a variable', script: '.$tool x; ."$dir\\run.ps1"', commands: [] },
  { name: 'stop-parsing', script: 'icacls x --% /grant Users:(F) ; shutdown', commands: ['icacls'] },
  { name: 'a switch value', script: "switch ($x) { reboot { Write-Output 'x' } }", commands: ['Write-Output'] },

  // Every command is found
  { name: 'a command on the next line', script: 'Write-Host ok\nshutdown /s /t 0', commands: ['Write-Host', 'shutdown'] },
  { name: 'a string that ends in a backslash', script: 'Get-ChildItem "C:\\temp\\"; shutdown /s /t 0', commands: ['Get-ChildItem', 'shutdown'] },
  { name: 'an assigned command', script: '$x = shutdown /s /t 0', commands: ['shutdown'] },
  { name: 'a command name that starts with a digit', script: '7z a x.zip', commands: ['7z'] },
  { name: '$( ) in a string', script: 'Write-Output "now: $(Restart-Computer)"', commands: ['Write-Output', 'Restart-Computer'] },
  { name: 'a script block argument', script: 'Invoke-Command { Stop-Computer }', commands: ['Invoke-Command', 'Stop-Computer'] },
  { name: 'a quoted path called through &', script: "& 'C:\\Windows\\System32\\shutdown.exe' /s", commands: ['C:\\Windows\\System32\\shutdown.exe'] },
  { name: 'commands in if and else', script: 'if (Test-Path x) { Remove-Item x } else { New-Item x }', commands: ['Test-Path', 'Remove-Item', 'New-Item'] },
  { name: 'a command after a using statement', script: 'using namespace System.IO; shutdown /r /t 0', commands: ['shutdown'] },
  { name: 'a hashtable value that is a command', script: '@{ Stage = Get-Date }', commands: ['Get-Date'] },
  { name: 'hashtable keys that are expressions', script: '@{ @(shutdown) = 1; [string](reboot) = 2; Name = Get-A | Get-B }', commands: ['shutdown', 'reboot', 'Get-A', 'Get-B'] },
  { name: 'a member named by a pipeline', script: '$x.(shutdown)', commands: ['shutdown'] },
  // Both editions read U+0085, U+2028 and U+2029 as blanks, and U+FEFF as part of a word
  { name: 'Unicode blanks', script: 'Write-Output ok; shutdown /s; reboot; Write-Output\u0085x', commands: ['Write-Output', 'shutdown', 'reboot'] },
  { name: 'a U+FEFF after --% is no blank', script: 'cmd --%﻿; shutdown', commands: ['cmd', 'shutdown'] },
  // A here-string's value ends before the line end that comes before its closing quote
  { name: 'here-strings called through &', script: "& @'\nshutdown\n'@ /s; & @\"\nre`start\n\"@", commands: ['shutdown', 'restart'] },
  { name: 'a here-string with CR line ends and a blank after @', script: "& @' \rshutdown\r'@ /s", commands: ['shutdown'] },
  { name: 'a doubled quote in a string and in a here-string', script: '& "a""b"; & @"\na""b\n"@; & "c"""', commands: ['a"b', 'a""b', 'c"'] },
  { name: 'an escaped line end does not end a here-string', script: '& @"\nab`\n"@\nx\n"@; shutdown', commands: ['ab\n"@\nx', 'shutdown'] },
  // < > # and ] end a bare word only where one starts: a<#b is one word, ]#x is ] and a comment
  { name: '<# inside a word is not a comment', script: 'Write-Output a<#b\nshutdown', commands: ['Write-Output', 'shutdown'] },
  { name: 'a ] that starts a word', script: "Write-Output ]#'\nshutdown", commands: ['Write-Output', 'shutdown'] },
  { name: 'commands joined by &&', script: 'git pull && npm install', commands: ['git', 'npm'], powershell7: true },
  // After a command PowerShell 7 reads & as "in the background"; a new statement follows
  { name: 'a statement after a background &', script: 'Start-Job x & . shutdown', commands: ['Start-Job', 'shutdown'], powershell7: true },
  { name: 'a string after a background & is not called', script: "Write-Output x & 'shutdown'", commands: ['Write-Output'], powershell7: true },
  // After a keyword statement & calls what follows
  { name: '& after a keyword statement', script: "continue & 'shutdown'", commands: ['shutdown'] },
  { name: 'an escaped blank before a name', script: '` shutdown', commands: ['shutdown'] },
  // A word that only looks like an operator or keyword starts a command named that way
  { name: '-Name starts a command', script: '-Name x; shutdown', commands: ['-Name', 'shutdown'] },
  { name: '+= starts a command', script: '+= x; shutdown', commands: ['+=', 'shutdown'] },
  { name: 'param without ( is a command', script: "param \n & 'shutdown'", commands: ['param', 'shutdown'] },
  { name: 'a clause keyword that starts a statement is a command', script: 'else shutdown', commands: ['else'] },
  { name: 'a keyword joined to more text is a word', script: 'if<x; return>x; foreach#x\nshutdown', commands: ['if<x', 'return>x', 'foreach#x', 'shutdown'] },
  { name: 'a redirection that starts a statement', script: '2>&1 x<#y\nshutdown', commands: ['2>&1', 'shutdown'] },
  // A label counts only before a loop, also past blank lines
  { name: 'a label before no loop is a command', script: ':lbl shutdown', commands: [':lbl'] },
  { name: 'a label before a loop on a later line', script: ':lbl\n\nforeach ($i in 1) { shutdown }', commands: ['shutdown'] },
  // --% works only as a word on its own, and its raw text ends at a new line, or at | or && outside "..."
  { name: '--% ends at &&', script: 'Write-Output --% a && shutdown', commands: ['Write-Output', 'shutdown'], powershell7: true },
  { name: '--%x is a plain word', script: 'Write-Output --%x shutdown', commands: ['Write-Output'] },
  { name: '--% text keeps | inside "..."', script: 'Write-Output --% "a | b" | shutdown', commands: ['Write-Output', 'shutdown'] },
  { name: '--% text keeps && inside curly quotes', script: 'Write-Output --% “a && b” && shutdown', commands: ['Write-Output', 'shutdown'], powershell7: true },
  { name: '--% text ends at a new line inside "..."', script: 'Write-Output --% "a | b\nshutdown', commands: ['Write-Output', 'shutdown'] },
  // A parameter token keeps $ and ` as text, so ${ opens a script block
  { name: 'a script block glued to a parameter', script: 'Write-Output -x${shutdown}', commands: ['Write-Output', 'shutdown'] },
  { name: 'a backtick in a parameter is text', script: 'Write-Output -x`;shutdown', commands: ['Write-Output', 'shutdown'] },
  { name: 'a parameter ends after :, at . and at [', script: 'Write-Output -x$env:a${shutdown} -y.${reboot} -z[${halt}', commands: ['Write-Output'] },
  { name: 'a quote makes a parameter a bare word', script: 'Write-Output -x"a"${shutdown}', commands: ['Write-Output'] },
  { name: 'any dash and letter start a parameter', script: 'Write-Output –x${shutdown} -é${reboot} -1${halt} --x${init}', commands: ['Write-Output', 'shutdown', 'reboot'] },
  { name: 'a parameter that starts a statement', script: '-x${shutdown}', commands: ['-x$', 'shutdown'] },
  // `e and `u{...} are escapes from PowerShell 6 on; Windows PowerShell reads them as e and u
  { name: 'escapes PowerShell 7 decodes', script: '& "`exit"; `u{73}hutdown', commands: ['\x1bxit', 'shutdown'], powershell7: true },
  { name: 'the last code point', script: '`u{10FFFF}x', commands: ['\u{10FFFF}x'], powershell7: true },
  { name: 'the same escapes in Windows PowerShell', script: '& "`exit"; `u{73}hutdown', commands: ['exit', 'u'], powershell5: true },
  { name: 'a ] inside a word', script: 'Write-Output a]#b\nshutdown', commands: ['Write-Output', 'shutdown'] },
  { name: 'arguments continued after a comma', script: 'Write-Output a,\n  b; shutdown', commands: ['Write-Output', 'shutdown'] },
  { name: 'a comment after an expression', script: '$x = 1 # http://x/y(VS.85).aspx\nshutdown', commands: ['shutdown'] },
  // Configuration is a keyword only where DSC exists: PowerShell on Linux and macOS fails to parse it
  { name: 'a configuration', script: 'Configuration C { shutdown }', commands: ['shutdown'], windowsOnly: true },
  // Windows PowerShell only: PowerShell 7 has no workflows
  { name: 'a workflow', script: 'workflow W { shutdown }', commands: ['shutdown'], powershell5: true },
  // Keyword statements and what they take
  { name: 'exit, break and continue', script: "exit shutdown; break & 'reboot'; continue outer", commands: ['shutdown', 'reboot'] },
  { name: 'a return value runs in the background before &', script: "return shutdown & 'reboot'", commands: ['shutdown'], powershell7: true },
  { name: 'clause keywords that start statements', script: 'elseif a\ncatch b\nfinally c\nuntil d', commands: ['elseif', 'catch', 'finally', 'until'] },
  { name: 'a label before for and while', script: ':a\n\nfor (;;) { }\n:b <#x#> while ($true) { shutdown }', commands: ['shutdown'] },
  { name: '.. starts a command', script: '.. x; shutdown', commands: ['..', 'shutdown'] },
  { name: '--% ends at |', script: 'Write-Output --% a | shutdown', commands: ['Write-Output', 'shutdown'] },
  { name: '--% glued to $ is a word', script: 'Write-Output --%$y & shutdown', commands: ['Write-Output', 'shutdown'], powershell7: true },
  { name: 'statements after && and a keyword statement', script: "& git && & 'npm'; foreach ($i in 1) { } & 'shutdown'", commands: ['git', 'npm', 'shutdown'], powershell7: true },
  // Forms Windows PowerShell modules use
  { name: 'a unary -join in parentheses', script: '$json = ConvertFrom-Json (-Join $lines)', commands: ['ConvertFrom-Json'] },
  { name: 'braced variable names', script: '$d += ${ENV:ProgramFiles(x86)}, "${ENV:ProgramFiles(x86)}\\*"; Write-Verbose "log: ${logPath}:"; Get-Item x', commands: ['Write-Verbose', 'Get-Item'] },
  { name: 'members after a parenthesized pipeline', script: '($t | ?{ $_.Text -eq "It" }).count | Should -Be 1', commands: ['?', 'Should'] },
  { name: 'an index, then a method', script: '$v = $parts[1].Trim(); Set-Item x', commands: ['Set-Item'] },
  { name: 'escaped $ in a -replace pattern', script: '% { $_ -replace "\\`$sha\\`$", "$change" } | Set-Content x', commands: ['%', 'Set-Content'] },
  { name: 'a variable at the end of a string', script: '$exe = ""; if (Test-Path "$base/node$exe") { }', commands: ['Test-Path'] },
  { name: 'doubled quotes in a double-quoted string', script: '$n = $x.SelectSingleNode("*[@Id=""$f""]"); Write-Host y', commands: ['Write-Host'] },
  { name: 'line continuations with CRLF', script: 'Remove-Thing `\r\n    -Name \'x\' `\r\n    -Force', commands: ['Remove-Thing'] },
  { name: 'a string that starts on a continued line', script: "Write-Host `\r\n'a\r\nshutdown'", commands: ['Write-Host'] },
  { name: 'Param and ( on separate CRLF lines', script: 'Param\r\n(\r\n$p\r\n)\r\nGet-Item x', commands: ['Get-Item'] },
  { name: 'a function straight after a block comment', script: '<#\r\n#>function F { shutdown }', commands: ['shutdown'] },
  { name: 'a class with attributes and a method', script: 'class K {\r\n[DscProperty(Key)]\r\n[string] $Name\r\n[void] Set() { Set-Thing -Name x }\r\n}', commands: ['Set-Thing'] },
  { name: 'a switch default that is an expression', script: "$kind = switch ($m['kind']) {\r\n default { $_.ToLower() }\r\n}", commands: [] },
  { name: 'an index with blanks, then a pipeline', script: '$Script:Mods[ $_.Name ] = $v\r\n$m = Get-Module -ListAvailable | sort Name', commands: ['Get-Module', 'sort'] },
  { name: 'typed and braced declarations', script: '[string[]] $list; [byte[]] ${Mask}; Get-Thing', commands: ['Get-Thing'] },
  { name: 'a called variable and a script block', script: '$cmd = {& $wrapped @PSBoundParameters | foreach { $_ } }', commands: ['foreach'] },
  { name: 'an empty single-quoted string', script: "$n = $a | Where-Object { $_.Key -match '^no-.' -and $_.Value -eq '' } | Select-Object -Expand Key", commands: ['Where-Object', 'Select-Object'] },
  { name: 'else on its own CRLF line', script: 'if ($x) {\r\n}\r\nelse\r\n{\r\n Get-Thing\r\n}', commands: ['Get-Thing'] },
  { name: 'dot-sourcing an expandable path', script: '. $here\\Tools.ps1', commands: [] },
  { name: 'strings joined by a comma without blanks', script: "$a = 'x','y'; $b = \"x\",\"y\"; Get-Thing", commands: ['Get-Thing'] },
  { name: 'an empty hashtable and an index expression', script: '$h = @{}; $v = $x[(1 + 1)]; Get-Thing', commands: ['Get-Thing'] },
  { name: 'a braced variable before ;', script: 'try { $m = "{0}" -f ${Block} ; Get-A } catch { Get-B }', commands: ['Get-A', 'Get-B'] },
  { name: 'a foreach variable longer than one letter', script: 'foreach ($item in $list) { Get-Thing }', commands: ['Get-Thing'] },
  { name: 'a member named by a string', script: '$v = $x."name".$y; Get-Thing', commands: ['Get-Thing'] },
  { name: 'switch with its { on the next line', script: "$kind = switch ($m['k'])\r\n{\r\n default { $_.ToLower() }\r\n}\r\nGet-Thing", commands: ['Get-Thing'] },
  { name: 'dot-sourcing in a hashtable value', script: "$h = @{ Key = . Get-A; Other = 'x' }", commands: ['Get-A'] },
  { name: 'an empty here-string, then if and else', script: '$b = @"\r\n"@\r\nif ($x) { } else { Get-A }', commands: ['Get-A'] },
  { name: 'a here-string line that starts with a quote', script: '$t = @"\n"quoted line"\nGet-A\n"@; Get-B', commands: ['Get-B'] },
  { name: 'an enum inside catch', script: 'try { } catch { enum E { A; B } }\nfinally { Get-A }', commands: ['Get-A'] },
  { name: 'a class in a subexpression and in a do loop', script: '$x = $(class K { [void] M() { Get-A } }\n); do { class L { [void] M() { Get-B } } } until ($true)', commands: ['Get-A', 'Get-B'] },
  { name: '& after return, throw and exit calls', script: "return & 'Get-A'\nthrow & 'Get-B'\nexit & 'Get-C'\nbreak out & 'Get-D'", commands: ['Get-A', 'Get-B', 'Get-C', 'Get-D'] },
  { name: 'a named data section', script: 'data d { "x" }', commands: [] },
  { name: 'a ] or an escaped blank that starts a statement', script: '] x\n` `Get-Thing', commands: [']', 'Get-Thing'] },
  { name: '--% after a leading <', script: "< --% x ' y\n& Get-Thing", commands: ['<', 'Get-Thing'] },
  { name: "a class with its { on the next line", script: 'class K\r\n{\r\n  [void] M() { Get-A }\r\n}\r\nGet-B', commands: ['Get-A', 'Get-B'] },
  { name: 'an @ and an escape inside a here-string', script: '$t = @"\nmail a@b.c `$x\nGet-A\n"@; Get-B', commands: ['Get-B'] },
  { name: 'if with its { on the next line', script: 'if ($x)\r\n{\r\n}\r\nelse\r\n{\r\n Get-A\r\n}', commands: ['Get-A'] },
  { name: 'an empty string after a comma', script: "$v = 'a','';Get-A; $w = \"b\",\"\";Get-B", commands: ['Get-A', 'Get-B'] },
  { name: 'a command in parentheses in an expression', script: '$y = 1 + (Get-A)', commands: ['Get-A'] },
  { name: 'quotes inside a bare word', script: "Write-Output a'b c'd; Get-A", commands: ['Write-Output', 'Get-A'] },
  { name: 'quotes inside a command name', script: "sh'ut'do\"wn\" /s", commands: ['shutdown'] },
  { name: 'a variable in a bare word has no index or members', script: 'Write-Output a$x[ ; shutdown; Write-Output a$x.y(reboot)', commands: ['Write-Output', 'shutdown', 'reboot'] },
  { name: 'an escape that starts a line', script: 'Get-A\n`s', commands: ['Get-A', 's'] },
  {
    name: 'members after a type, between empty here-strings',
    script: 'if ($x) {\r\n  $b = @"\r\n"@\r\n  $e = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($b))\r\n  $m = @"\r\n"@\r\n}\r\nelse { Get-A }',
    commands: ['Get-A'],
  },
];

export const SEED = 20261025;
export const GENERATED = 500;

// The names PowerShell's own parser finds in each script: nothing is run
const POWERSHELL_PARSE = `
$scripts = Get-Content -Raw -Encoding UTF8 -LiteralPath $env:DC_SCRIPTS_FILE | ConvertFrom-Json
$results = foreach ($script in $scripts) {
  $tokens = $null; $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseInput($script, [ref]$tokens, [ref]$errors)
  $names = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true) |
    ForEach-Object { $_.GetCommandName() } | Where-Object { $_ })
  [pscustomobject]@{ errors = $errors.Count; names = $names }
}
[Console]::OutputEncoding = [Text.Encoding]::UTF8
ConvertTo-Json -InputObject @{ major = $PSVersionTable.PSVersion.Major; results = @($results) } -Depth 4 -Compress
`;

// The editions a script's expected commands hold in
function editionsOf(c) {
  if (c.powershell7) return ['powershell'];
  if (c.powershell5) return ['windows-powershell'];
  return ['windows-powershell', 'powershell'];
}

function parseWithPowerShell(powershell, scripts) {
  const scriptsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dc-ps-scripts-')), 'scripts.json');
  fs.writeFileSync(scriptsFile, JSON.stringify(scripts), 'utf8');
  const run = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_PARSE], {
    encoding: 'utf8',
    maxBuffer: 1 << 26,
    timeout: 120000,
    env: { ...process.env, DC_SCRIPTS_FILE: scriptsFile },
  });
  fs.rmSync(path.dirname(scriptsFile), { recursive: true, force: true });
  assert.ok(!run.error, `PowerShell's parser did not run: ${run.error?.message}`);
  assert.strictEqual(run.status, 0, `PowerShell's parser did not run: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

async function runTests() {
  let failures = 0;
  function check(name, actual, expected) {
    try {
      assert.deepStrictEqual(actual, expected);
      console.log(`✓ ${name}`);
    } catch {
      failures++;
      console.error(`✗ ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }
  const sorted = (list) => [...new Set(list)].sort();
  const names = (script, edition) => sorted(powershellCommandWords(script, edition));
  const byEdition = (c, value) => Object.fromEntries(editionsOf(c).map((edition) => [edition, value(edition)]));
  const read = (c) => byEdition(c, (edition) => names(c.script, edition));
  const expected = (c) => byEdition(c, () => sorted(c.commands));

  console.log('The commands each script runs');
  for (const c of CASES) check(c.name, read(c), expected(c));

  console.log(`\n${GENERATED} generated scripts (seed ${SEED})`);
  const generated = generatePowerShellScripts(SEED, GENERATED);
  const wrong = generated.filter((s) => JSON.stringify(read(s)) !== JSON.stringify(expected(s)));
  wrong.slice(0, 5).forEach((s) => check(JSON.stringify(s.script), read(s), expected(s)));
  check(`every generated script gives its expected commands (${wrong.length} differ)`, wrong.length, 0);

  console.log("\nPowerShell's own parser finds the same names");
  // Every installed edition: Windows has 5.1, and often 7 beside it
  const installed = [resolveShellPath('powershell'), resolveShellPath('pwsh')].filter((shell) => shell);
  if (installed.length === 0) skip("PowerShell is not installed: the cases were not compared with PowerShell's own parser");
  const all = [...CASES.map((c) => ({ ...c, label: c.name })), ...generated.map((s, i) => ({ ...s, label: `generated script ${i}` }))];
  for (const powershell of installed) {
    const { major, results } = parseWithPowerShell(powershell, all.map((c) => c.script));
    const edition = major >= 7 ? 'powershell' : 'windows-powershell';
    const notHere = (c) => !editionsOf(c).includes(edition) || (c.windowsOnly && process.platform !== 'win32');
    const skipped = all.filter(notHere);
    if (skipped.length > 0) skip(`${skipped.length} scripts hold only in the other edition (&&, background &, \`e and \`u{} from 7 on, workflows in 5) or parse only on Windows (configuration): not compared with PowerShell ${major}'s parser`);
    const compared = all.map((c, i) => ({ c, result: results[i] })).filter(({ c }) => !notHere(c));
    const parseErrors = compared.filter(({ result }) => result.errors > 0);
    parseErrors.slice(0, 5).forEach(({ c, result }) => check(`PowerShell ${major} parses ${c.label} without errors`, result.errors, 0));
    check(`PowerShell ${major} parses all ${compared.length} scripts without errors (${parseErrors.length} have errors)`, parseErrors.length, 0);
    const differ = compared.filter(({ c, result }) => JSON.stringify(sorted([].concat(result.names))) !== JSON.stringify(names(c.script, edition)));
    differ.slice(0, 5).forEach(({ c, result }) => check(`PowerShell ${major}: ${c.label}`, names(c.script, edition), sorted([].concat(result.names))));
    check(`PowerShell ${major} finds the same names in all ${compared.length} scripts (${differ.length} differ)`, differ.length, 0);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    return false;
  }
  console.log('\nAll checks passed');
  return true;
}

runIfMain(import.meta.url, runTests);
