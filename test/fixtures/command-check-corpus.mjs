/**
 * The command-check corpus: one case per command, with the shell it would run
 * in and the answer the check SHOULD give — "allow", or the blocked program
 * name that would really run. test-command-check-corpus.js checks each answer.
 *
 * Nothing here is ever executed. Commands are only passed to a parser. Each
 * `command` is the exact text a user/AI sent to start_process; `shell` is the
 * shell start_process would run it in (so the correct reading is that shell's).
 * `expect` is null when no blocked program runs, or the blocked program's
 * name when one really does. A Windows path names no program on other
 * systems, so a case with one gives its answer by process.platform.
 * `expectPerShell`, when set, gives the answer for one PowerShell program
 * where it differs from `expect`: in Windows PowerShell 5.1 sc is the alias of
 * Set-Content, while PowerShell 7 has no such alias and runs sc.exe.
 *
 * Groups: case = support cases; issue = GitHub issues; table = a PowerShell
 * @{ } table: its keys and text values are data, but a value, or a key in ( ),
 * is a command that runs; bypass = blocked programs that slip through today;
 * name = a blocked program's name written another way (in quotes, with an
 * escape, a path, capitals or .exe); meaning = a PowerShell name whose meaning
 * there (an alias, or a program) decides what runs; long = the 14k-char case;
 * control = a plain blocked program, to keep every approach honest.
 */

const nl = '\n';

// A >14,000-char case-01-style command: documentary JSON in a PowerShell
// here-string, the Spanish word "su" only as prose.
const longProse = 'texto documental de respaldo; '.repeat(480); // ~14,400 chars
const long01 = [
  "$p=@'",
  '{"informe":"segun su estado anterior: ' + longProse + '"}',
  "'@|ConvertFrom-Json",
  '$p|ConvertTo-Json -Compress',
].join(nl);

export const CORPUS = [
  // ---- Support cases (text we have; synthetic where the original was withheld) ----
  {
    id: 'case01', group: 'case', shell: 'powershell', expect: null,
    command: ["$p=@'", '{"report":"su estado anterior; texto `documental`"}', "'@|ConvertFrom-Json", '$p|ConvertTo-Json -Compress'].join(nl),
    note: "su is Spanish prose inside @' '@; nothing blocked runs",
  },
  {
    id: 'case02', group: 'case', shell: 'powershell', expect: null,
    command: "Write-Output 'the word Su is data'", note: 'Su inside a single-quoted literal',
  },
  {
    id: 'case03', group: 'case', shell: 'bash', expect: null,
    command: "python3 - <<'PY'" + nl + 'sc = 1' + nl + 'print(sc)' + nl + 'PY', note: 'Python var sc in a quoted heredoc',
  },
  {
    id: 'case04', group: 'case', shell: 'bash', expect: null,
    command: "python3 - <<'PY'" + nl + 'import re' + nl + "# don't log credentials" + nl + "m = re.search(r'(password|passwd|secret)', line)" + nl + 'PY',
    note: 'passwd in a regex in a quoted heredoc',
  },
  {
    id: 'case05', group: 'case', shell: 'bash', expect: null,
    command: 'docker compose create --pull never', note: 'no blocked name present',
  },
  {
    id: 'case06', group: 'case', shell: 'powershell', expect: null,
    command: "$diagnostic = @'" + nl + 'print(format(1.5, ".2f"))' + nl + "'@" + nl + "$diagnostic | & 'C:\\proj\\.venv\\Scripts\\python.exe' -B -",
    note: "format() Python in @' '@ piped to python",
  },
  {
    id: 'case08', group: 'case', shell: 'powershell', expect: null,
    command: '$c.Mounts | ForEach-Object { [pscustomobject]@{ Container = $c.Name; Mount = $_.Destination } }', note: 'hashtable key Mount',
  },
  {
    id: 'case09', group: 'case', shell: 'bash', expect: null,
    command: "python3 - <<'PY'" + nl + 'cipher = ()' + nl + 'print(list(cipher))' + nl + 'PY', note: 'Python var cipher in a quoted heredoc',
  },
  {
    id: 'case10', group: 'case', shell: 'bash', expect: null,
    command: "python3 - <<'PY'" + nl + 'print(format(1234.5, ","))' + nl + 'PY', note: 'Python format() in a quoted heredoc',
  },

  // ---- GitHub issues ----
  {
    id: 'i731', group: 'issue', shell: 'powershell', expect: null,
    command: "@'" + nl + "a='''" + nl + 'int32(Format)' + nl + "'''" + nl + "'@ | py -3 -", note: '#731 C++ Format in a here-string',
  },
  {
    id: 'i795', group: 'issue', shell: 'bash', expect: null,
    command: "python3 - <<'PY'" + nl + "REG = 'example'" + nl + 'print(REG)' + nl + 'PY', note: '#795 Python REG in a heredoc',
  },
  {
    id: 'i795b', group: 'issue', shell: 'zsh', expect: null,
    command: "/usr/bin/python3 -B <<'PY'" + nl + 'v=os.statvfs(mount)' + nl + 'PY', note: '#795 mount in a zsh heredoc',
  },
  {
    id: 'i799', group: 'issue', shell: 'bash', expect: null,
    command: "python3 - <<'PY'" + nl + "code = r'''f.write('COPY local_table FROM STDIN WITH (FORMAT csv);\\n')'''" + nl + 'PY', note: '#799 SQL FORMAT in nested Python',
  },
  {
    id: 'i822', group: 'issue', shell: 'bash', expect: null,
    command: "python3 -B - <<'PY'" + nl + "prompt='''the user's text; format ONLY the new files.'''" + nl + 'PY', note: '#822 format in prompt prose',
  },
  {
    id: 'i834', group: 'issue', shell: 'powershell', expect: null,
    command: "$metadata = [ordered]@{ Stage='preflight'; Operation='Device init then read-only health check' }; $metadata | ConvertTo-Json",
    note: '#834 init in a hashtable value',
  },
  {
    id: 'i890', group: 'issue', shell: 'powershell', expect: null,
    command: '& $client init --help', note: '#890 init is a subcommand of a variable executable',
  },
  {
    id: 'i873', group: 'issue', shell: 'bash', expect: null,
    command: "python -B - <<'PY'" + nl + 'reg = 1' + nl + 'print(reg)' + nl + 'PY', note: '#873 Python reg in a heredoc',
  },
  {
    id: 'i423', group: 'issue', shell: 'bash', expect: 'sudo',
    command: '"sudo" id', note: '#423 quoted name the shell still runs as sudo',
  },
  {
    id: 'i421', group: 'issue', shell: 'bash', expect: 'su',
    command: 's""u -', note: '#421 empty quotes split the name; the shell rejoins s""u to su',
  },

  // ---- PowerShell @{ } tables: keys and text values are data, but a value can be a command ----
  { id: 'tbl_keys', group: 'table', shell: 'powershell', expect: null, command: "@{ Mount = 1; Net = 2; 'sc' = 3 }", note: 'keys are data, quoted or not' },
  { id: 'tbl_value_literal', group: 'table', shell: 'powershell', expect: null, command: "@{ Note = 'users: $(net user)' }", note: 'a single-quoted value is text, so its $( ) never runs' },
  { id: 'tbl_value_cmd', group: 'table', shell: 'powershell', expect: 'net', command: '@{ A = net user }', note: 'a table value is a statement, so net runs when the table is built' },
  { id: 'tbl_value_subexpr', group: 'table', shell: 'powershell', expect: 'net', command: '@{ Note = "users: $(net user)" }', note: "#834's reporter's case: $( ) inside a double-quoted value runs net" },

  // ---- Bypasses: a blocked program main's check lets run ----
  { id: 'byp_quote', group: 'bypass', shell: 'bash', expect: 'sudo', command: '"sudo" id', note: 'quoted name' },
  { id: 'byp_newline', group: 'bypass', shell: 'bash', expect: 'sudo', command: 'echo hi' + nl + 'sudo ls', note: 'sudo on a second line' },
  { id: 'byp_if', group: 'bypass', shell: 'bash', expect: 'sudo', command: 'if sudo true; then :; fi', note: 'sudo after if' },
  { id: 'byp_scexe', group: 'bypass', shell: 'powershell', expect: 'sc', command: 'sc.exe stop Spooler', note: 'sc.exe runs the sc program; main reads sc.exe as another name than sc' },

  // ---- A blocked name written another way: the shell still runs the same program ----
  { id: 'name_amp_quote', group: 'name', shell: 'powershell', expect: 'sudo', command: "& 'sudo' whoami", note: 'the call operator runs the quoted name' },
  { id: 'name_backslash', group: 'name', shell: 'bash', expect: 'sudo', command: '\\sudo ls', note: 'bash drops the backslash and runs sudo' },
  { id: 'name_ansi_c', group: 'name', shell: 'bash', expect: 'sudo', command: "$'\\x73udo' ls", note: "bash decodes $'\\x73udo' to sudo" },
  { id: 'name_cmd_quote', group: 'name', shell: 'cmd', expect: 'net', command: '"net" user', note: 'cmd drops the quotes and runs net' },
  { id: 'name_cmd_caret', group: 'name', shell: 'cmd', expect: 'net', command: 'n^et user', note: 'cmd drops the ^ and runs net' },
  { id: 'name_ps_path', group: 'name', shell: 'powershell', expect: process.platform === 'win32' ? 'sc' : null, command: 'C:\\Windows\\System32\\SC.EXE query', note: 'sc.exe by its full path, in capitals: sc on Windows; elsewhere that path names no program' },
  { id: 'name_cmd_exe', group: 'name', shell: 'cmd', expect: 'sc', command: 'sc.exe stop Spooler', note: 'cmd runs sc.exe for sc.exe as for sc' },
  { id: 'name_cmd_path', group: 'name', shell: 'cmd', expect: process.platform === 'win32' ? 'sc' : null, command: '"C:\\Windows\\System32\\SC.EXE" query', note: 'sc.exe by its full path, quoted and in capitals: sc on Windows; elsewhere that path names no program' },
  { id: 'name_gitbash_exe', group: 'name', shell: 'bash', expect: 'sc', command: 'sc.exe query', note: 'Git Bash on Windows runs sc.exe; sc.exe is read as sc on every system' },
  { id: 'name_gitbash_path', group: 'name', shell: 'bash', expect: process.platform === 'win32' ? 'sc' : null, command: "'C:\\Windows\\System32\\sc.exe' query", note: 'Git Bash runs a quoted Windows path; its backslashes are part of the path. Elsewhere that path names no program' },

  // ---- What a name means in PowerShell: an alias runs its target, not a program of that name ----
  { id: 'meaning_sc', group: 'meaning', shell: 'powershell', expect: null, expectPerShell: { pwsh: 'sc' }, command: 'sc query', note: 'Windows PowerShell 5.1 runs Set-Content, the target of its alias sc; PowerShell 7 has no sc alias and runs sc.exe' },

  // ---- The 14k-char case ----
  { id: 'long01', group: 'long', shell: 'powershell', expect: null, command: long01, note: '14k chars; su only as Spanish prose in a here-string' },

  // ---- Controls: a plain blocked program must always be caught ----
  { id: 'ctl_sudo', group: 'control', shell: 'bash', expect: 'sudo', command: 'sudo ls', note: 'plain' },
  { id: 'ctl_chain', group: 'control', shell: 'bash', expect: 'sudo', command: 'echo ok && sudo ls', note: 'chained' },
  { id: 'ctl_pipe', group: 'control', shell: 'bash', expect: 'iptables', command: 'echo x | iptables -L', note: 'piped' },
  { id: 'ctl_sub', group: 'control', shell: 'bash', expect: 'sudo', command: 'echo "$(sudo id)"', note: 'in $() inside double quotes' },
  { id: 'ctl_path', group: 'control', shell: 'bash', expect: 'sudo', command: '/usr/bin/sudo ls', note: 'path to sudo' },
  { id: 'ctl_net', group: 'control', shell: 'powershell', expect: 'net', command: 'net stop Spooler', note: 'plain net' },
  { id: 'ctl_netexe', group: 'control', shell: 'powershell', expect: process.platform === 'win32' ? 'net' : null, command: 'C:\\Windows\\System32\\net.exe user', note: 'net.exe by path: net on Windows; elsewhere that path names no program, so nothing runs' },
  { id: 'ctl_allow', group: 'control', shell: 'bash', expect: null, command: 'echo "Hello World"', note: 'plainly safe' },
];
