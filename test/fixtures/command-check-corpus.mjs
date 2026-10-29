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
 * block = a blocked program inside a { } group, a function body or a PowerShell
 * script block;
 * expansion = a command name that bash and zsh build by brace expansion
 * ({sudo,ls} runs sudo);
 * name = a blocked program's name written another way (in quotes, with an
 * escape, a path, capitals or .exe); meaning = a PowerShell name whose meaning
 * there (an alias, or a program) decides what runs;
 * ownfunc = a script's own function named like a blocked program;
 * long = the 14k-char case; control = a plain blocked program, to keep every
 * approach honest.
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
  {
    id: 'case11', group: 'case', shell: 'bash', expect: null,
    command: ['halt() {', '  echo "ERROR: $*" >&2', '  exit 1', '}', 'docker load -i "$ARCHIVE" || halt "docker load failed"'].join(nl),
    note: 'bash function named halt, defined and called',
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
  { id: 'byp_brace', group: 'bypass', shell: 'bash', expect: 'sudo', command: '{ sudo ls; }', note: 'brace group; sudo is the first command' },
  { id: 'byp_quote', group: 'bypass', shell: 'bash', expect: 'sudo', command: '"sudo" id', note: 'quoted name' },
  { id: 'byp_newline', group: 'bypass', shell: 'bash', expect: 'sudo', command: 'echo hi' + nl + 'sudo ls', note: 'sudo on a second line' },
  { id: 'byp_if', group: 'bypass', shell: 'bash', expect: 'sudo', command: 'if sudo true; then :; fi', note: 'sudo after if' },
  { id: 'byp_scexe', group: 'bypass', shell: 'powershell', expect: 'sc', command: 'sc.exe stop Spooler', note: 'sc.exe runs the sc program; main reads sc.exe as another name than sc' },

  // ---- Blocks: a blocked program inside a { } group, a function body or a PowerShell script block ----
  { id: 'blk_fn_body', group: 'block', shell: 'bash', expect: 'sudo', command: 'f() { sudo ls; }; f', note: 'calling f runs sudo from its body' },
  { id: 'blk_if_group', group: 'block', shell: 'bash', expect: 'reboot', command: 'if true; then { reboot; }; fi', note: 'a { } group inside an if body' },
  { id: 'blk_ps_amp', group: 'block', shell: 'powershell', expect: 'sudo', command: '& { sudo }', note: '& runs the script block, and the block runs sudo' },
  { id: 'blk_ps_foreach', group: 'block', shell: 'powershell', expect: 'net', command: '1..3 | ForEach-Object { net user }', note: 'ForEach-Object runs its script block once per item' },
  { id: 'blk_group_ok', group: 'block', shell: 'bash', expect: null, command: '{ echo hi; }', note: 'a { } group whose program is allowed' },
  { id: 'blk_fn_ok', group: 'block', shell: 'bash', expect: null, command: 'f() { echo hi; }; f', note: 'a function whose body is allowed' },
  { id: 'blk_ps_amp_ok', group: 'block', shell: 'powershell', expect: null, command: '& { Get-Date }', note: 'a script block written in the command is read' },
  { id: 'blk_ps_dot_ok', group: 'block', shell: 'powershell', expect: null, command: '. { Get-Date }', note: 'the same with the dot operator' },
  { id: 'blk_ps_foreach_ok', group: 'block', shell: 'powershell', expect: null, command: '1..3 | ForEach-Object { Get-Date }', note: 'ForEach-Object with an allowed block' },

  // ---- Brace expansion: bash and zsh turn {a,b} in a command name into words, and the first one runs ----
  { id: 'exp_brace', group: 'expansion', shell: 'bash', expect: 'sudo', command: '{sudo,ls}', note: 'expands to "sudo ls"' },
  { id: 'exp_brace_zsh', group: 'expansion', shell: 'zsh', expect: 'sudo', command: '{sudo,ls}', note: 'zsh expands it the same way' },
  { id: 'exp_brace_sh', group: 'expansion', shell: 'sh', expect: 'sudo', command: '{sudo,ls}', note: 'read as bash; dash has no brace expansion, but there {sudo,ls} names no program, so refusing it stops nothing that would run' },
  { id: 'exp_brace_empty', group: 'expansion', shell: 'bash', expect: 'sudo', command: '{,sudo} ls', note: 'bash drops the empty word, so this is "sudo ls"' },
  { id: 'exp_brace_none', group: 'expansion', shell: 'bash', expect: 'sudo', command: '{,} sudo ls', note: '{,} expands to no word at all, so sudo is the name' },
  { id: 'exp_brace_inner', group: 'expansion', shell: 'bash', expect: 'sudo', command: 's{u,}do ls', note: 'braces inside the name: "sudo sdo ls"' },
  { id: 'exp_brace_seq', group: 'expansion', shell: 'bash', expect: 'sudo', command: 'su{d..d}o ls', note: 'a one-letter sequence: "sudo ls"' },
  { id: 'exp_brace_seq_plus', group: 'expansion', shell: 'bash', expect: 'sudo', command: 'su{d..d..+1}o ls', note: 'a sequence with a + step, which bash 4 and later read: "sudo ls"' },
  { id: 'exp_brace_nested', group: 'expansion', shell: 'bash', expect: 'sudo', command: '{s{u,x}do,ls}', note: 'nested braces: "sudo sxdo ls"' },
  { id: 'exp_brace_dq_piece', group: 'expansion', shell: 'bash', expect: 'sudo', command: '{"su"do,ls}', note: 'a quoted piece inside the braces is still part of the word: "sudo ls"' },
  { id: 'exp_brace_sq_piece', group: 'expansion', shell: 'bash', expect: 'sudo', command: "{'sudo',ls}", note: 'the same with single quotes' },
  { id: 'exp_brace_later', group: 'expansion', shell: 'bash', expect: 'reboot', command: 'echo hi; {reboot,now}', note: 'the second command\'s name: "reboot now"' },
  { id: 'exp_brace_var_empty', group: 'expansion', shell: 'bash', expect: 'sudo', command: '{$X,sudo} id', note: '"$X sudo id": when $X is empty, bash drops that word and runs "sudo id"' },
  { id: 'exp_brace_var_outside', group: 'expansion', shell: 'bash', expect: 'sudo', command: '$X{,} sudo', note: '"$X $X sudo": when $X is empty, both words go and sudo is the name' },
  { id: 'exp_brace_var_joined', group: 'expansion', shell: 'bash', expect: 'sudo', command: '{$X,su}do id', note: '"$Xdo sudo id": bash reads the letters after $X into its name, and $Xdo may be empty' },
  { id: 'exp_brace_args', group: 'expansion', shell: 'bash', expect: null, command: 'cp file{,.bak} /tmp', note: 'braces in an argument: cp runs' },
  { id: 'exp_brace_echo', group: 'expansion', shell: 'bash', expect: null, command: 'echo {sudo,ls}', note: 'braces in an argument: echo runs' },
  { id: 'exp_brace_esc_comma', group: 'expansion', shell: 'bash', expect: null, command: '{su\\,do,ls}', note: 'an escaped comma is text: "su,do ls"' },
  { id: 'exp_brace_quoted', group: 'expansion', shell: 'bash', expect: null, command: '"{sudo,ls}"', note: 'quoted braces are text: the program is named {sudo,ls}' },
  { id: 'exp_brace_escaped', group: 'expansion', shell: 'bash', expect: null, command: '\\{sudo,ls}', note: 'an escaped brace is text' },
  { id: 'exp_brace_q_comma', group: 'expansion', shell: 'bash', expect: null, command: '{"sudo,ls"}', note: 'a quoted comma is text, so there is no list' },
  { id: 'exp_brace_var', group: 'expansion', shell: 'bash', expect: null, command: '{$X,ls}', note: 'the name is $X\'s value, known only at run time, or ls when $X is empty' },
  { id: 'exp_brace_var_quoted', group: 'expansion', shell: 'bash', expect: null, command: '{"$X",sudo} id', note: 'a quoted "$X" stays a word even when it is empty, so sudo is an argument' },
  { id: 'exp_brace_var_text', group: 'expansion', shell: 'bash', expect: null, command: '{x$X,sudo} id', note: 'x$X is never empty, so sudo is an argument' },

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

  // ---- Own functions: a call to the script's own function is not the blocked program, but its body is checked ----
  { id: 'fn_format', group: 'ownfunc', shell: 'bash', expect: null, command: ['format() {', '  printf "%s\\n" "$1"', '}', 'format report.txt'].join(nl), note: 'own function format, called after; body has no blocked program' },
  { id: 'fn_mount', group: 'ownfunc', shell: 'bash', expect: null, command: 'mount() { echo "$1"; }; mount /data', note: 'own function mount, called after' },
  { id: 'fn_sudo', group: 'ownfunc', shell: 'bash', expect: null, command: 'sudo() { echo "refuse"; }; sudo ls', note: 'own function sudo, called after' },
  { id: 'fn_net_ps', group: 'ownfunc', shell: 'powershell', expect: null, command: 'function net { param($a) "net $a" }; net status', note: 'own PowerShell function net, called after' },
  { id: 'fn_sc_ps', group: 'ownfunc', shell: 'powershell', expect: null, command: 'function sc { param($a) $a }; sc query', note: 'own PowerShell function sc, called after' },
  { id: 'fn_body_runs_sudo', group: 'ownfunc', shell: 'bash', expect: 'sudo', command: 'deploy() {' + nl + '  sudo rm -rf /opt/x' + nl + '}' + nl + 'deploy', note: 'own function deploy, but its body runs the real sudo' },
  { id: 'fn_call_before_def', group: 'ownfunc', shell: 'bash', expect: 'sudo', command: 'sudo ls' + nl + 'sudo() { echo "refuse"; }', note: 'sudo called before the definition is the real program' },
  {
    id: 'fn_deploy_script', group: 'ownfunc', shell: 'bash', expect: null,
    command: [
      '#!/bin/bash',
      'set -euo pipefail',
      'ARCHIVE="/srv/release/app-image.tar"',
      'IMAGE="registry.example/app:1.2.3"',
      'halt() {',
      '  echo "ERROR: $*" >&2',
      '  exit 1',
      '}',
      '[ -f "$ARCHIVE" ] || halt "archive missing: $ARCHIVE"',
      'echo "$EXPECTED_SHA  $ARCHIVE" | sha256sum -c - >/dev/null || halt "hash mismatch"',
      'if docker image inspect --format \'{{.Id}}\' "$IMAGE" >/dev/null 2>&1; then',
      '  halt "image already present: $IMAGE"',
      'fi',
      'docker load -i "$ARCHIVE"',
    ].join(nl),
    note: "case 11's whole deployment script, written from the customer's description: its own halt, called after || and inside if",
  },
  { id: 'fn_called_from_fn', group: 'ownfunc', shell: 'bash', expect: null, command: ['halt() { echo "ERROR: $*" >&2; exit 1; }', 'main() { docker load -i "$ARCHIVE" || halt "load failed"; }', 'main'].join(nl), note: 'the own halt, called from another function of the script' },
  { id: 'fn_body_path', group: 'ownfunc', shell: 'bash', expect: 'halt', command: 'halt() { /sbin/halt -p; }; halt', note: 'the body of the own halt runs /sbin/halt' },
  { id: 'fn_path_after', group: 'ownfunc', shell: 'bash', expect: 'halt', command: 'halt() { echo stop; }; /sbin/halt -p', note: 'a path is the program, even after an own halt' },
  { id: 'fn_in_subshell', group: 'ownfunc', shell: 'bash', expect: 'sudo', command: '( sudo() { :; } ); sudo ls', note: 'sudo defined only inside a subshell' },
  { id: 'fn_in_fn', group: 'ownfunc', shell: 'bash', expect: 'sudo', command: 'f() { sudo() { :; }; }; sudo ls', note: 'sudo defined only inside another function, which never runs' },
  { id: 'fn_after_or', group: 'ownfunc', shell: 'bash', expect: 'sudo', command: 'true || sudo() { :; }; sudo ls', note: 'sudo defined only after a || that does not run' },
  { id: 'fn_unset', group: 'ownfunc', shell: 'bash', expect: 'halt', command: 'halt() { echo stop; }; unset -f halt; halt', note: 'unset -f removed the own halt' },
  { id: 'fn_builtin_unset', group: 'ownfunc', shell: 'bash', expect: 'halt', command: 'halt() { echo stop; }; builtin unset -f halt; halt', note: 'builtin unset -f removed the own halt' },
  { id: 'fn_unhash_zsh', group: 'ownfunc', shell: 'zsh', expect: 'halt', command: 'halt() { echo stop; }; unhash -f halt; halt', note: "zsh's unhash -f removed the own halt" },
  { id: 'fn_unset_written_before', group: 'ownfunc', shell: 'bash', expect: 'halt', command: 'cleanup() { unset -f halt; }; halt() { echo stop; }; cleanup; halt', note: 'the unset is written before the definition, but runs when cleanup is called after it' },
  { id: 'fn_call_written_before', group: 'ownfunc', shell: 'bash', expect: 'halt', command: 'halt() { echo stop; }; main() { halt; }; unset -f halt; main', note: 'the call is written before the unset, but runs when main is called after it' },
  { id: 'fn_case_ps', group: 'ownfunc', shell: 'powershell', expect: null, command: "function Net { 'x' }; net status", note: 'PowerShell finds a function whatever the case of its name' },
  { id: 'fn_in_block_ps', group: 'ownfunc', shell: 'powershell', expect: 'net', command: "& { function net { 'x' } }; net user", note: 'net defined only inside a script block' },
  { id: 'fn_remove_item_ps', group: 'ownfunc', shell: 'powershell', expect: 'net', command: "function net { 'x' }; Remove-Item function:net; net user", note: 'Remove-Item function:net removed the own net' },
  { id: 'fn_remove_pipe_ps', group: 'ownfunc', shell: 'powershell', expect: 'net', command: "function net { 'x' }; 'function:net' | Remove-Item; net user", note: 'Remove-Item with the path from the pipeline removed the own net' },
  { id: 'fn_variable_ps', group: 'ownfunc', shell: 'powershell', expect: 'net', command: "function net { 'x' }; $function:net = $null; net user", note: '$function:net = $null removed the own net' },
  { id: 'fn_start_job_ps', group: 'ownfunc', shell: 'powershell', expect: 'net', command: "function net { 'x' }; Start-Job { net user } | Receive-Job -Wait", note: "a job runs in another process, where the script's functions don't exist" },
  { id: 'fn_eval_unset', group: 'ownfunc', shell: 'bash', expect: 'halt', command: "halt() { :; }; eval 'unset -f halt'; halt", note: 'the unset -f that eval runs removed the own halt' },
  { id: 'fn_command_eval', group: 'ownfunc', shell: 'bash', expect: 'halt', command: "halt() { :; }; command eval 'unset -f halt'; halt", note: 'eval after command removed the own halt' },
  { id: 'fn_trap_unset', group: 'ownfunc', shell: 'bash', expect: 'halt', command: "halt() { :; }; trap 'unset -f halt' DEBUG; halt", note: 'the DEBUG trap runs unset -f before the call' },
  { id: 'fn_source', group: 'ownfunc', shell: 'bash', expect: 'halt', command: 'halt() { :; }; . ./lib.sh; halt', note: 'the file . runs is read in this shell, and may remove the own halt' },
  { id: 'fn_mapfile_callback', group: 'ownfunc', shell: 'bash', expect: 'halt', command: "halt() { :; }; mapfile -C 'unset -f halt' -c 1 lines < list.txt; halt", note: "mapfile's -C callback removed the own halt" },
  { id: 'fn_emulate_zsh', group: 'ownfunc', shell: 'zsh', expect: 'halt', command: "halt() { :; }; emulate sh -c 'unset -f halt'; halt", note: "zsh's emulate -c removed the own halt" },
  { id: 'fn_runtime_name', group: 'ownfunc', shell: 'bash', expect: 'halt', command: 'halt() { :; }; u=unset; $u -f halt; halt', note: 'a command named at run time ($u is unset) removed the own halt' },
  { id: 'fn_dot_argument', group: 'ownfunc', shell: 'bash', expect: null, command: "halt() { echo stop; }; find . -name '*.log'; halt", note: 'a . that is only an argument runs no file: the own halt stays' },
  { id: 'fn_iex_ps', group: 'ownfunc', shell: 'powershell', expect: 'net', command: "function net { 'x' }; Invoke-Expression 'Remove-Item function:net'; net user", note: 'the Remove-Item that Invoke-Expression runs removed the own net' },
  { id: 'fn_iex_built_ps', group: 'ownfunc', shell: 'powershell', expect: 'net', command: "function net { 'x' }; iex ('Remove-Item fun' + 'ction:net'); net user", note: 'Invoke-Expression of text built at run time removed the own net' },
  { id: 'fn_runtime_name_ps', group: 'ownfunc', shell: 'powershell', expect: 'net', command: "function net { 'x' }; $c = 'iex'; & $c ('Remove-Item fun' + 'ction:net'); net user", note: 'a command named at run time ($c is iex) removed the own net' },
  { id: 'fn_script_file_ps', group: 'ownfunc', shell: 'powershell', expect: 'net', command: "function net { 'x' }; . ./lib.ps1; net user", note: 'a script file runs in this session, and may remove the own net' },
  { id: 'fn_method_ps', group: 'ownfunc', shell: 'powershell', expect: 'net', command: "function net { 'x' }; [scriptblock]::Create('Remove-Item function:net').Invoke(); net user", note: 'a script block made from text by a method removed the own net' },
  { id: 'fn_noglob_eval_zsh', group: 'ownfunc', shell: 'zsh', expect: 'halt', command: "halt() { :; }; noglob eval 'unset -f halt'; halt", note: "eval after zsh's noglob removed the own halt" },
  { id: 'fn_set_content_ps', group: 'ownfunc', shell: 'powershell', expect: 'net', command: "function net { 'x' }; Set-Content -Path ('func' + 'tion:net') -Value 'net.exe user'; net user", note: 'Set-Content with a path built at run time gave the own net a new body' },
  { id: 'fn_foreach_method_ps', group: 'ownfunc', shell: 'powershell', expect: 'net', command: "function net { 'x' }; $ExecutionContext.InvokeCommand | ForEach-Object InvokeScript ('Remove-Item fun' + 'ction:net'); net user", note: 'ForEach-Object called a method that ran text and removed the own net' },
  { id: 'fn_foreach_property_ps', group: 'ownfunc', shell: 'powershell', expect: null, command: "function net { 'x' }; Get-Item . | ForEach-Object Name; net user", note: 'ForEach-Object reading a property runs no code: the own net stays' },
  { id: 'fn_add_type_ps', group: 'ownfunc', shell: 'powershell', expect: 'net', command: "function net { 'x' }; Add-Type -Path ./Tools.cs; net user", note: 'Add-Type loads code that may remove the own net' },
  { id: 'fn_import_module_ps', group: 'ownfunc', shell: 'powershell', expect: 'net', command: "function net { 'x' }; Import-Module ./tools.psm1; net user", note: 'a module runs in this session, and may remove the own net' },
  { id: 'fn_path_no_extension_ps', group: 'ownfunc', shell: 'powershell', expect: 'net', command: "function net { 'x' }; . ./lib; net user", note: '. ./lib runs lib.ps1, which may remove the own net' },
  { id: 'fn_exe_path_ps', group: 'ownfunc', shell: 'powershell', expect: null, command: "function net { 'x' }; & 'C:\\Windows\\System32\\where.exe' git; net user", note: 'a program by its path runs no PowerShell code: the own net stays' },
  { id: 'fn_alias', group: 'ownfunc', shell: 'bash', expect: 'halt', command: ['halt() { echo stop; }', 'shopt -s expand_aliases', 'alias halt=/sbin/halt', 'halt'].join(nl), note: 'with expand_aliases, an alias comes before the own halt' },
  { id: 'fn_set_alias_ps', group: 'ownfunc', shell: 'powershell', expect: 'net', command: "function net { 'x' }; Set-Alias net net.exe; net user", note: 'an alias comes before a function: net runs net.exe' },
  { id: 'fn_new_alias_ps', group: 'ownfunc', shell: 'powershell', expect: 'net', command: "function net { 'x' }; New-Alias net net.exe; net user", note: 'New-Alias made net run net.exe, before the own net' },
  { id: 'fn_alias_drive_ps', group: 'ownfunc', shell: 'powershell', expect: 'net', command: "function net { 'x' }; New-Item alias:net -Value net.exe; net user", note: 'an alias made on the alias: drive comes before the own net' },
  { id: 'fn_alias_variable_ps', group: 'ownfunc', shell: 'powershell', expect: 'net', command: "function net { 'x' }; $alias:net = 'net.exe'; net user", note: '$alias:net made net run net.exe, before the own net' },

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
