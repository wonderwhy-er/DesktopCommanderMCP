/**
 * posixCommandWords finds every command a POSIX shell (sh, bash, zsh, dash, ksh)
 * runs for a script, and nothing the shell only reads as data. Checked three ways:
 * - the commands from the bug reports, and the forms a shell-blind scanner reads wrong
 * - generated scripts whose answer is known by construction (helpers/posix-scripts.js)
 * - when bash 5 is installed, bash runs those generated scripts with every command
 *   recording its name; what bash runs must be exactly the expected answer, which
 *   checks the answers themselves
 */
import assert from 'assert';
import { spawnSync } from 'child_process';
import { posixCommandWords } from '../dist/utils/posix-commands.js';
import { resolveShellPath } from '../dist/utils/shell.js';
import { generatePosixScripts } from './helpers/posix-scripts.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

// Each case: a script, and the names of the commands the shell runs, as written
export const CASES = [
  // Data is not a command
  { name: 'Python in a quoted heredoc', script: "python3 - <<'PY'\nREG = 'example'\nprint(REG)\nPY", commands: ['python3'] },
  { name: 'SQL in Python source in a heredoc', script: "python3 - <<'PY'\ncode = r'''f.write('COPY t FROM STDIN WITH (FORMAT csv);\\n')'''\nPY", commands: ['python3'] },
  { name: 'prose with a ; in a heredoc', script: "python3 -B - <<'PY'\nprompt='''the user's text; format ONLY the new files.'''\nPY", commands: ['python3'] },
  { name: 'a heredoc line that starts with a blocked name', script: "cat > notes.md <<'EOF'\nFormat the output as a table.\nEOF", commands: ['cat'] },
  { name: 'a quoted heredoc under zsh', script: "/usr/bin/python3 -B <<'PY'\nv=os.statvfs(mount)\nPY", commands: ['/usr/bin/python3'] },
  { name: 'backticks in single quotes', script: "git commit -m 'docs: explain the `format` option'", commands: ['git'] },
  { name: 'single-quoted $( )', script: "echo '$(sudo id)'", commands: ['echo'] },
  { name: 'a comment', script: 'ls # then format the disk', commands: ['ls'] },
  { name: 'a case pattern', script: 'case "$1" in reboot) echo restart;; esac', commands: ['echo'] },
  { name: 'arithmetic', script: 'echo $(( (1 + 2) * 3 ))', commands: ['echo'] },
  { name: 'the word after a quoted variable', script: '"$tool" init --help', commands: [] },

  // Every command is found
  { name: 'a command on the next line', script: 'echo safe\nsudo whoami', commands: ['echo', 'sudo'] },
  { name: 'a command after a heredoc', script: "python3 - <<'PY'\nprint(1)\nPY\nsudo reboot", commands: ['python3', 'sudo'] },
  { name: '$( ) in an unquoted heredoc', script: 'cat <<EOF\n$(sudo id)\nEOF', commands: ['cat', 'sudo'] },
  { name: 'a process substitution', script: 'diff <(sudo cat /etc/shadow) /dev/null', commands: ['diff', 'sudo'] },
  { name: '$( ) in a parameter default', script: 'echo ${X:-$(sudo id)}', commands: ['echo', 'sudo'] },
  { name: 'a quoted command name', script: '"sudo" whoami', commands: ['sudo'] },
  // An unquoted expansion can leave no word, and then the next word is the command
  { name: 'the word after a command named by a variable', script: '$tool init --help', commands: ['init'] },
  { name: 'a command after an empty expansion', script: '$X sudo id; $(true) reboot; $1 halt', commands: ['sudo', 'true', 'reboot', 'halt'] },
  // bash reads $(( as arithmetic only when )) closes the group the second ( opens
  { name: '$(( that is a command substitution', script: 'out=$((cd build && sudo make) 2>&1)', commands: ['cd', 'sudo'] },
  // dash and ash read (( as two subshells, and bash does too unless )) closes it
  { name: '(( that is two subshells', script: '((sudo x); echo y)', commands: ['sudo', 'echo'] },
  { name: '<< in (( )) is no heredoc', script: '(( x << 2 ))\nsudo y', commands: ['x', 'sudo'] },
  { name: 'a heredoc in a ( ) subshell', script: "( cat <<'EOF'\nsudo x\nEOF\n)", commands: ['cat'] },
  { name: '! and a subshell', script: '!(sudo x)', commands: ['sudo'] },
  // Git for Windows' bash reads a CRLF line end as a line end
  { name: 'a command alone on a CRLF line', script: 'echo ok\r\nreboot\r\n', commands: ['echo', 'reboot'] },
  { name: 'a heredoc with CRLF line ends', script: "cat <<'EOF'\r\nsudo x\r\nEOF\r\nreboot\r\n", commands: ['cat', 'reboot'] },
  { name: 'a case with CRLF line ends', script: 'case x in\r\n x) sudo y;;\r\nesac', commands: ['sudo'] },
  // [[ ]] is read up to a line end: dash has no [[ and reads the next line as a command
  { name: 'a CRLF line end inside [[ ]]', script: '[[ -n a &&\r\n -n b ]]\r\nsudo y', commands: ['-n', 'sudo'] },
  { name: "zsh's =( ) process substitution", script: 'diff =(sudo cat a) b', commands: ['diff', 'sudo'] },
  // ${ cmd; } runs cmd in bash 5.3, ksh93 and mksh: older bash refuses it, so these aren't generated
  { name: '${ cmd; } in double quotes', script: 'echo "${ sudo id; }"; reboot', commands: ['echo', 'sudo', 'reboot'] },
  { name: '${ cmd; } holding a { } group', script: 'echo ${ { sudo x; }; reboot; }', commands: ['echo', 'sudo', 'reboot'] },
  { name: 'ANSI-C escapes in a name', script: "$'\\x73udo' reboot", commands: ['sudo'] },
  // $'\\' is \ and $'\'' is ', and an escape bash doesn't know keeps its backslash
  { name: 'ANSI-C escapes that keep a name apart', script: String.raw`$'s\\u\'d\"o\?\q' x`, commands: [String.raw`s\u'd"o?\q`] },
  { name: 'a select body', script: 'select x in a b; do sudo y; done', commands: ['sudo'] },
  { name: 'coproc', script: 'coproc sudo x', commands: ['sudo'] },
  // coproc NAME takes only a compound command, so a word with one after it names the coprocess
  { name: 'a named coproc', script: 'coproc cp (sudo x)\ncoproc c { reboot; }\ncoproc n while halt; do :; done', commands: ['sudo', 'reboot', 'halt', ':'] },
  { name: 'a coproc command with a brace word', script: 'coproc sudo {a,b}', commands: ['sudo'] },
  // do or { can follow a for header without a separator
  { name: 'for without in, and for (( )) without a separator', script: 'for i do sudo x; done; for ((i=0;i<1;i++)) do reboot; done; for ((;;)) { halt; }', commands: ['sudo', 'reboot', 'halt'] },
  { name: 'the words after for ... in are data', script: 'for sha1 in sudo x\ndo :; done', commands: [':'] },
  { name: 'a command after [[ ]]', script: '[[ -n x ]] && sudo y', commands: ['sudo'] },
  // A name that is partly an expansion is only known when the script runs
  { name: 'a name with an expansion in it', script: 'v${tool}x arg; "$tool"x; `which sudo`x; run_$1 x; "$@"; ${2} y; "cmd_$(echo x)" y', commands: ['which', 'y', 'echo'] },
  { name: 'a command after a backtick substitution', script: 'echo `which a`; sudo x', commands: ['echo', 'which', 'sudo'] },
  { name: 'a variable inside $( ) in double quotes', script: 'x="$(readlink $d)"; echo y', commands: ['readlink', 'echo'] },
  { name: 'special parameters', script: '[ $# -eq 0 ] && chmod x "$@"', commands: ['[', 'chmod'] },
  { name: '$[ ] arithmetic', script: 'echo $[1 + $(sudo id)]', commands: ['echo', 'sudo'] },
  { name: 'arithmetic before &&', script: 'echo $(( 2 * 3 )) && sudo x', commands: ['echo', 'sudo'] },
  { name: 'an escaped $( in ${ } is data', script: ': ${x:-\\$(sudo id)}', commands: [':'] },
  { name: 'quotes inside ${ } inside double quotes', script: 'echo "${x:-"$(sudo id)"}"', commands: ['echo', 'sudo'] },
  // The first } that isn't quoted, escaped or nested in another expansion ends ${ }
  { name: 'a bare { does not nest in ${ }', script: 'echo ${x:-{a} ; sudo y}', commands: ['echo', 'sudo'] },
  { name: 'a <<- heredoc with tabs', script: 'cat <<-EOF\n\tsudo x\n\tEOF\nreboot', commands: ['cat', 'reboot'] },
  // bash decodes $'...' in a delimiter: the body ends at EOF, and what follows runs
  { name: "a $'...' heredoc delimiter", script: "cat <<$'E\\x4fF'\nhi\nEOF\nsudo y\ncat <<$\"EOF\"\nhi\nEOF\nreboot", commands: ['cat', 'sudo', 'reboot'] },
  // bash ends a $'...' string at a NUL and goes on with the word
  { name: 'a NUL in an ANSI-C string', script: "$'sudo\\0x' id; $'ech\\x00z'o y", commands: ['sudo', 'echo'] },
  { name: 'a named file descriptor', script: '{fd}>/dev/null sudo x', commands: ['sudo'] },
  { name: 'a quoted redirection target', script: 'echo x >"$f"; rm y', commands: ['echo', 'rm'] },
  { name: 'a line continuation after >', script: 'echo a > \\\n  /dev/null; sudo b', commands: ['echo', 'sudo'] },
  { name: 'a process substitution as input', script: 'while read l; do sudo x; done < <(ls)', commands: ['read', 'sudo', 'ls'] },
  { name: 'a process substitution as an argument', script: 'tee >(gzip > f) | sudo x', commands: ['tee', 'gzip', 'sudo'] },
  { name: 'case patterns with quotes, | and tabs', script: 'case $x in\n\t"a b" | c ) sudo y;;\nesac', commands: ['sudo'] },
  { name: 'a function on one line', script: 'function f { sudo x; }; function g() { reboot; }; f', commands: ['sudo', 'reboot', 'f'] },
  { name: 'a CR at the very end', script: 'reboot\r', commands: ['reboot'] },
  // zsh's short forms run the command after (( )), [[ ]] and a closing }
  { name: "zsh's anonymous function", script: '() { sudo x }', commands: ['sudo'] },
  { name: "zsh's short if", script: 'if [[ -n x ]] sudo y', commands: ['sudo'] },
  { name: "zsh's short forms after (( ))", script: 'if (( x )) { sudo y }; while (( z )) { reboot }', commands: ['x', 'sudo', 'z', 'reboot'] },
  // foreach and repeat are commands to other shells
  { name: "zsh's short loops", script: 'for i (1) sudo x; for a b (1 2) { reboot }; foreach i (1) halt; end; repeat 2 shutdown', commands: ['sudo', 'reboot', 'foreach', 'halt', 'end', 'repeat', 'shutdown'] },
  { name: "zsh's always block", script: '{ echo a; } always { reboot; }', commands: ['echo', 'reboot'] },
  { name: "zsh's precommand modifiers", script: 'noglob sudo x; - reboot; nocorrect shutdown', commands: ['sudo', 'reboot', 'shutdown'] },
  // Bash runs nothing of these, but a stray ) or } doesn't stop the reading
  { name: 'a stray ) does not hide what follows', script: 'echo $(date) ) ; sudo x', commands: ['echo', 'date', 'sudo'] },
  { name: 'a stray } does not hide what follows', script: 'echo a; }; sudo x', commands: ['echo', 'sudo'] },
  // zsh reads a ( ) group after a word as a glob
  { name: 'a ( ) group after a word is data', script: 'echo x (sudo|halt); reboot', commands: ['echo', 'reboot'] },
  // Forms from real system scripts that a slightly wrong reader gets wrong
  { name: 'a line continuation before a quoted word', script: 'echo \\\n"a b"; sudo y', commands: ['echo', 'sudo'] },
  { name: 'a subshell in $( ) in [[ ]]', script: '[[ -n $( (true); sudo b\n) ]]', commands: ['true', 'sudo'] },
  { name: 'a $ that ends a double-quoted string', script: 'grep "^x$" f; sudo y', commands: ['grep', 'sudo'] },
  { name: 'a heredoc inside $( ) ends there', script: "x=$(cat <<'EOF'\nhi\nEOF\n)\nsudo y\nreboot", commands: ['cat', 'sudo', 'reboot'] },
  { name: 'a quoted } in ${ }', script: ': ${x:-"}"}; sudo y', commands: [':', 'sudo'] },
  { name: 'a | in ${ }', script: 'x=${i%|*}; sudo y', commands: ['sudo'] },
  { name: 'an escaped blank in an array', script: 'x=(a\\ b $(sudo c))', commands: ['sudo'] },
  { name: 'nested $(( ))', script: 'echo $(( 1 + $(( 2 * 3 )) )); sudo x', commands: ['echo', 'sudo'] },
  { name: 'a quoted ) in a later case pattern', script: "case $v in c | 'a)b' ) sudo x;; esac", commands: ['sudo'] },
  { name: 'a case subject after a line continuation', script: 'case \\\n  "$x" in\n  a) sudo y;;\nesac', commands: ['sudo'] },
  { name: 'tabs around case and in', script: 'case $x\tin\n\ta) sudo y;;\nesac', commands: ['sudo'] },
];

export const SEED = 20261025;
export const GENERATED = 500;

// Runs the scripts in bash with each c<n> a function that writes "<script> ran c<n>" to fd 3,
// which $( ) and pipes don't capture. PATH points nowhere, so nothing else can run.
function runInBash(bash, scripts) {
  const names = Math.max(0, ...scripts.flatMap((s) => [...s.script.matchAll(/\bc(\d+)/g)].map((m) => Number(m[1])))) + 1;
  const quoted = (text) => `'${text.replace(/'/g, `'\\''`)}'`;
  const program = [
    'i=0',
    `while [ $i -lt ${names} ]; do eval "c$i() { printf '%s ran c$i\\\\n' \\"\\$script\\" >&3; }"; i=$((i + 1)); done`,
    'PATH=/nonexistent',
    ...scripts.map((s, i) => `script=${i}; ( eval ${quoted(s.script)} ) 3>&1 >/dev/null 2>&1 </dev/null`),
  ].join('\n');
  const run = spawnSync(bash, ['-s'], { input: program, encoding: 'utf8', maxBuffer: 1 << 26, timeout: 120000 });
  assert.ok(!run.error, `bash did not run: ${run.error?.message}`);
  const ran = scripts.map(() => new Set());
  for (const line of run.stdout.split(/\r?\n/)) {
    const match = /^(\d+) ran (c\d+)$/.exec(line);
    if (match) ran[Number(match[1])].add(match[2]);
  }
  return ran;
}

function bashMajorVersion(bash) {
  const run = spawnSync(bash, ['-c', 'echo ${BASH_VERSINFO[0]}'], { encoding: 'utf8', timeout: 30000 });
  return run.status === 0 ? Number(run.stdout.trim()) : undefined;
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
  const names = (script) => [...new Set(posixCommandWords(script))].sort();

  console.log('The commands each script runs');
  for (const c of CASES) check(c.name, names(c.script), [...new Set(c.commands)].sort());

  console.log(`\n${GENERATED} generated scripts (seed ${SEED})`);
  const generated = generatePosixScripts(SEED, GENERATED);
  const wrong = generated.filter((s) => JSON.stringify(names(s.script)) !== JSON.stringify(s.commands));
  wrong.slice(0, 5).forEach((s) => check(JSON.stringify(s.script), names(s.script), s.commands));
  check(`every generated script gives its expected commands (${wrong.length} differ)`, wrong.length, 0);

  console.log('\nbash runs exactly the commands the generated scripts expect');
  const bash = resolveShellPath('bash');
  const major = bash ? bashMajorVersion(bash) : undefined;
  if (major === undefined) {
    skip('bash is not installed: the generated answers were not checked against bash');
  } else if (major < 5) {
    skip(`bash ${major} is older than the versions the generated scripts were checked against (5.1, 5.2)`);
  } else {
    const ran = runInBash(bash, generated);
    const differ = generated.filter((s, i) => JSON.stringify([...ran[i]].sort()) !== JSON.stringify(s.commands.filter((c) => /^c\d+$/.test(c))));
    differ.slice(0, 5).forEach((s) => check(`bash ${major}: ${JSON.stringify(s.script)}`, [...ran[generated.indexOf(s)]].sort(), s.commands.filter((c) => /^c\d+$/.test(c))));
    check(`bash ${major} runs the expected commands in every generated script (${differ.length} differ)`, differ.length, 0);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    return false;
  }
  console.log('\nAll checks passed');
  return true;
}

runIfMain(import.meta.url, runTests);
