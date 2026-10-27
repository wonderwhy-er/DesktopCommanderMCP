/**
 * The command-check corpus: one case per command, with the shell it would run
 * in and the answer the check SHOULD give — "allow", or the blocked program
 * name that would really run. test-command-check-corpus.js checks each answer.
 *
 * Nothing here is ever executed. Commands are only passed to a parser. Each
 * `command` is the exact text a user/AI sent to start_process; `shell` is the
 * shell start_process would run it in (so the correct reading is that shell's).
 * `expect` is null when no blocked program runs, the blocked program's name
 * when one really does, or 'unknowable' when the program that runs cannot be
 * known from the text alone (run-time commands, a script file).
 * `blocklist` names the default entries that matter for the case.
 * `card` names the change that makes the check give this answer; the test
 * runs a command once its card is in. It is null for the wrappers and inline
 * shells, which no change covers yet.
 * `os`, when set, is the only system (a process.platform value) where the
 * answer holds: a Windows path to a program runs nothing elsewhere.
 *
 * Groups: case = the 11 support cases; issue = GitHub issues; bypass = blocked
 * programs that slip through today; wrapper = a blocked program reached through
 * a known wrapper; inline = a blocked program inside an inline-shell string;
 * runtime = a program chosen at run time (the check cannot see it); file = a
 * program named only in a script file; long = the 14k-char case; control = a
 * plain blocked program, to keep every approach honest.
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

export const BLOCKLIST_DEFAULT = [
  'mkfs', 'format', 'mount', 'umount', 'fdisk', 'dd', 'parted', 'diskpart',
  'sudo', 'su', 'passwd', 'adduser', 'useradd', 'usermod', 'groupadd', 'chsh', 'visudo',
  'shutdown', 'reboot', 'halt', 'poweroff', 'init',
  'iptables', 'firewall', 'netsh',
  'sfc', 'bcdedit', 'reg', 'net', 'sc', 'runas', 'cipher', 'takeown',
];

export const CORPUS = [
  // ---- The 11 support cases (text we have; synthetic where the original was withheld) ----
  {
    id: 'case01', card: 'B15', group: 'case', shell: 'powershell', expect: null, blocklist: ['su'],
    command: ["$p=@'", '{"report":"su estado anterior; texto `documental`"}', "'@|ConvertFrom-Json", '$p|ConvertTo-Json -Compress'].join(nl),
    note: "su is Spanish prose inside @' '@; nothing blocked runs",
  },
  {
    id: 'case02', card: 'B15', group: 'case', shell: 'powershell', expect: null, blocklist: ['su'],
    command: "Write-Output 'the word Su is data'", note: 'Su inside a single-quoted literal',
  },
  {
    id: 'case03', card: 'B15', group: 'case', shell: 'bash', expect: null, blocklist: ['sc'],
    command: "python3 - <<'PY'" + nl + 'sc = 1' + nl + 'print(sc)' + nl + 'PY', note: 'Python var sc in a quoted heredoc',
  },
  {
    id: 'case04', card: 'B15', group: 'case', shell: 'bash', expect: null, blocklist: ['passwd'],
    command: "python3 - <<'PY'" + nl + 'import re' + nl + "# don't log credentials" + nl + "m = re.search(r'(password|passwd|secret)', line)" + nl + 'PY',
    note: 'passwd in a regex in a quoted heredoc',
  },
  {
    id: 'case05', card: 'B15', group: 'case', shell: 'bash', expect: null, blocklist: [],
    command: 'docker compose create --pull never', note: 'no blocked name present',
  },
  {
    id: 'case06', card: 'B15', group: 'case', shell: 'powershell', expect: null, blocklist: ['format'],
    command: "$diagnostic = @'" + nl + 'print(format(1.5, ".2f"))' + nl + "'@" + nl + "$diagnostic | & 'C:\\proj\\.venv\\Scripts\\python.exe' -B -",
    note: "format() Python in @' '@ piped to python",
  },
  {
    id: 'case08', card: 'B19', group: 'case', shell: 'powershell', expect: null, blocklist: ['mount', 'net'],
    command: '$c.Mounts | ForEach-Object { [pscustomobject]@{ Container = $c.Name; Mount = $_.Destination } }', note: 'hashtable key Mount',
  },
  {
    id: 'case09', card: 'B15', group: 'case', shell: 'bash', expect: null, blocklist: ['cipher'],
    command: "python3 - <<'PY'" + nl + 'cipher = ()' + nl + 'print(list(cipher))' + nl + 'PY', note: 'Python var cipher in a quoted heredoc',
  },
  {
    id: 'case10', card: 'B15', group: 'case', shell: 'bash', expect: null, blocklist: ['format'],
    command: "python3 - <<'PY'" + nl + 'print(format(1234.5, ","))' + nl + 'PY', note: 'Python format() in a quoted heredoc',
  },
  {
    id: 'case11', card: 'D7', group: 'case', shell: 'bash', expect: null, blocklist: ['halt'],
    command: ['halt() {', '  echo "ERROR: $*" >&2', '  exit 1', '}', 'docker load -i "$ARCHIVE" || halt "docker load failed"'].join(nl),
    note: 'bash function named halt, defined and called',
  },

  // ---- GitHub issues ----
  {
    id: 'i731', card: 'B15', group: 'issue', shell: 'powershell', expect: null, blocklist: ['format'],
    command: "@'" + nl + "a='''" + nl + 'int32(Format)' + nl + "'''" + nl + "'@ | py -3 -", note: '#731 C++ Format in a here-string',
  },
  {
    id: 'i795', card: 'B15', group: 'issue', shell: 'bash', expect: null, blocklist: ['reg'],
    command: "python3 - <<'PY'" + nl + "REG = 'example'" + nl + 'print(REG)' + nl + 'PY', note: '#795 Python REG in a heredoc',
  },
  {
    id: 'i795b', card: 'B15', group: 'issue', shell: 'zsh', expect: null, blocklist: ['mount'],
    command: "/usr/bin/python3 -B <<'PY'" + nl + 'v=os.statvfs(mount)' + nl + 'PY', note: '#795 mount in a zsh heredoc',
  },
  {
    id: 'i799', card: 'B15', group: 'issue', shell: 'bash', expect: null, blocklist: ['format'],
    command: "python3 - <<'PY'" + nl + "code = r'''f.write('COPY local_table FROM STDIN WITH (FORMAT csv);\\n')'''" + nl + 'PY', note: '#799 SQL FORMAT in nested Python',
  },
  {
    id: 'i822', card: 'B15', group: 'issue', shell: 'bash', expect: null, blocklist: ['format'],
    command: "python3 -B - <<'PY'" + nl + "prompt='''the user's text; format ONLY the new files.'''" + nl + 'PY', note: '#822 format in prompt prose',
  },
  {
    id: 'i834', card: 'B19', group: 'issue', shell: 'powershell', expect: null, blocklist: ['init'],
    command: "$metadata = [ordered]@{ Stage='preflight'; Operation='Device init then read-only health check' }; $metadata | ConvertTo-Json",
    note: '#834 init in a hashtable value',
  },
  {
    id: 'i890', card: 'B15', group: 'issue', shell: 'powershell', expect: null, blocklist: ['init'],
    command: '& $client init --help', note: '#890 init is a subcommand of a variable executable',
  },
  {
    id: 'i873', card: 'B15', group: 'issue', shell: 'bash', expect: null, blocklist: ['reg'],
    command: "python -B - <<'PY'" + nl + 'reg = 1' + nl + 'print(reg)' + nl + 'PY', note: '#873 Python reg in a heredoc',
  },
  {
    id: 'i423', card: 'B22', group: 'issue', shell: 'bash', expect: 'sudo', blocklist: ['sudo'],
    command: '"sudo" id', note: '#423 quoted name the shell still runs as sudo',
  },
  {
    id: 'i421', card: 'B22', group: 'issue', shell: 'bash', expect: 'su', blocklist: ['su'],
    command: 's""u -', note: '#421 empty quotes split the name; the shell rejoins s""u to su',
  },

  // ---- Bypasses named in the card ----
  { id: 'byp_brace', card: 'B21', group: 'bypass', shell: 'bash', expect: 'sudo', blocklist: ['sudo'], command: '{ sudo ls; }', note: 'brace group; sudo is the first command' },
  { id: 'byp_quote', card: 'B22', group: 'bypass', shell: 'bash', expect: 'sudo', blocklist: ['sudo'], command: '"sudo" id', note: 'quoted name' },
  { id: 'byp_newline', card: 'B15', group: 'bypass', shell: 'bash', expect: 'sudo', blocklist: ['sudo'], command: 'echo hi' + nl + 'sudo ls', note: 'sudo on a second line' },
  { id: 'byp_if', card: 'B15', group: 'bypass', shell: 'bash', expect: 'sudo', blocklist: ['sudo'], command: 'if sudo true; then :; fi', note: 'sudo after if' },
  { id: 'byp_scexe', card: 'B22', group: 'bypass', shell: 'powershell', expect: 'sc', blocklist: ['sc'], command: 'sc.exe stop Spooler', note: 'sc.exe runs the sc program; today sc.exe != sc' },

  // ---- Wrappers: a blocked program reached through a known wrapper ----
  { id: 'wrap_env', card: null, group: 'wrapper', shell: 'bash', expect: 'sudo', blocklist: ['sudo'], command: 'env sudo ls', note: 'env runs sudo' },
  { id: 'wrap_nohup', card: null, group: 'wrapper', shell: 'bash', expect: 'shutdown', blocklist: ['shutdown'], command: 'nohup shutdown -h now', note: 'nohup runs shutdown' },
  { id: 'wrap_xargs', card: null, group: 'wrapper', shell: 'bash', expect: 'sudo', blocklist: ['sudo'], command: 'echo x | xargs sudo', note: 'xargs runs sudo' },
  { id: 'wrap_timeout', card: null, group: 'wrapper', shell: 'bash', expect: 'reboot', blocklist: ['reboot'], command: 'timeout 5 reboot', note: 'timeout runs reboot' },
  { id: 'wrap_nice', card: null, group: 'wrapper', shell: 'bash', expect: 'dd', blocklist: ['dd'], command: 'nice -n 10 dd if=/dev/zero of=/dev/sda', note: 'nice runs dd' },
  { id: 'wrap_sudou', card: null, group: 'wrapper', shell: 'bash', expect: 'sudo', blocklist: ['sudo'], command: 'sudo -u root id', note: 'sudo itself is blocked' },
  { id: 'wrap_exec', card: null, group: 'wrapper', shell: 'bash', expect: 'su', blocklist: ['su'], command: 'exec su -', note: 'exec runs su' },
  { id: 'wrap_command', card: null, group: 'wrapper', shell: 'bash', expect: 'sudo', blocklist: ['sudo'], command: 'command sudo ls', note: 'command runs sudo' },
  { id: 'wrap_startproc', card: null, group: 'wrapper', shell: 'powershell', expect: 'format', blocklist: ['format'], command: "Start-Process -FilePath format.com -ArgumentList 'D:'", note: 'Start-Process runs format' },
  { id: 'wrap_cmdstart', card: null, group: 'wrapper', shell: 'cmd', expect: 'format', blocklist: ['format'], command: 'start format D:', note: 'cmd start runs format' },
  { id: 'wrap_call', card: null, group: 'wrapper', shell: 'cmd', expect: 'net', blocklist: ['net'], command: 'call net stop Spooler', note: 'cmd call runs net' },

  // ---- Inline shells: a blocked program inside an inline-shell string ----
  { id: 'inline_bashc', card: null, group: 'inline', shell: 'bash', expect: 'sudo', blocklist: ['sudo'], command: "bash -c 'sudo ls'", note: 'bash -c runs sudo' },
  { id: 'inline_shc', card: null, group: 'inline', shell: 'bash', expect: 'reboot', blocklist: ['reboot'], command: 'sh -c "reboot"', note: 'sh -c runs reboot' },
  { id: 'inline_zshc', card: null, group: 'inline', shell: 'zsh', expect: 'shutdown', blocklist: ['shutdown'], command: "zsh -c 'shutdown -h now'", note: 'zsh -c runs shutdown' },
  { id: 'inline_pwshcmd', card: null, group: 'inline', shell: 'powershell', expect: 'net', blocklist: ['net'], command: "pwsh -Command 'net stop Spooler'", note: 'pwsh -Command runs net' },
  { id: 'inline_pwshenc', card: null, group: 'inline', shell: 'powershell', expect: 'net', blocklist: ['net'], command: 'pwsh -EncodedCommand bgBlAHQAIABzAHQAbwBwACAAUwBwAG8AbwBsAGUAcgA=', note: 'base64 of "net stop Spooler"' },
  { id: 'inline_pwshenc_short', card: null, group: 'inline', shell: 'powershell', expect: 'net', blocklist: ['net'], command: 'powershell -enc bgBlAHQAIABzAHQAbwBwACAAUwBwAG8AbwBsAGUAcgA=', note: '-enc short form' },
  { id: 'inline_cmdc', card: null, group: 'inline', shell: 'cmd', expect: 'net', blocklist: ['net'], command: 'cmd /c net stop Spooler', note: 'cmd /c runs net' },

  // ---- Run-time commands: the program is chosen at run time; the check cannot see it ----
  { id: 'rt_eval', card: 'B13', group: 'runtime', shell: 'bash', expect: 'unknowable', blocklist: ['sudo'], command: 'eval "$CMD"', note: 'the program is in $CMD, unknown until run time' },
  { id: 'rt_iex', card: 'B13', group: 'runtime', shell: 'powershell', expect: 'unknowable', blocklist: ['net'], command: 'Invoke-Expression $cmd', note: 'program in $cmd' },
  { id: 'rt_amp_var', card: 'B13', group: 'runtime', shell: 'powershell', expect: 'unknowable', blocklist: ['net'], command: '& $tool stop Spooler', note: 'the program is the value of $tool' },

  // ---- A program named only in a script file ----
  { id: 'file_bash', card: 'B13', group: 'file', shell: 'bash', expect: 'unknowable', blocklist: ['sudo'], command: 'bash deploy.sh', note: 'the commands are in deploy.sh, not in the text' },

  // ---- Own functions (a script's own function is not the blocked program;
  //      its body is still checked; a call before the definition is real) ----
  { id: 'fn_format', card: 'D7', group: 'ownfunc', shell: 'bash', expect: null, blocklist: ['format'], command: ['format() {', '  printf "%s\\n" "$1"', '}', 'format report.txt'].join(nl), note: 'own function format, called after; body has no blocked program' },
  { id: 'fn_mount', card: 'D7', group: 'ownfunc', shell: 'bash', expect: null, blocklist: ['mount'], command: 'mount() { echo "$1"; }; mount /data', note: 'own function mount, called after' },
  { id: 'fn_sudo', card: 'D7', group: 'ownfunc', shell: 'bash', expect: null, blocklist: ['sudo'], command: 'sudo() { echo "refuse"; }; sudo ls', note: 'own function sudo, called after' },
  { id: 'fn_net_ps', card: 'D7', group: 'ownfunc', shell: 'powershell', expect: null, blocklist: ['net'], command: 'function net { param($a) "net $a" }; net status', note: 'own PowerShell function net, called after' },
  { id: 'fn_sc_ps', card: 'D7', group: 'ownfunc', shell: 'powershell', expect: null, blocklist: ['sc'], command: 'function sc { param($a) $a }; sc query', note: 'own PowerShell function sc, called after' },
  { id: 'fn_body_runs_sudo', card: 'D7', group: 'ownfunc', shell: 'bash', expect: 'sudo', blocklist: ['sudo'], command: 'deploy() {' + nl + '  sudo rm -rf /opt/x' + nl + '}' + nl + 'deploy', note: 'own function deploy, but its body runs the real sudo' },
  { id: 'fn_call_before_def', card: 'D7', group: 'ownfunc', shell: 'bash', expect: 'sudo', blocklist: ['sudo'], command: 'sudo ls' + nl + 'sudo() { echo "refuse"; }', note: 'sudo called before the definition is the real program' },

  // ---- The 14k-char case ----
  { id: 'long01', card: 'B15', group: 'long', shell: 'powershell', expect: null, blocklist: ['su'], command: long01, note: '14k chars; su only as Spanish prose in a here-string' },

  // ---- Controls: a plain blocked program must always be caught ----
  { id: 'ctl_sudo', card: 'B15', group: 'control', shell: 'bash', expect: 'sudo', blocklist: ['sudo'], command: 'sudo ls', note: 'plain' },
  { id: 'ctl_chain', card: 'B15', group: 'control', shell: 'bash', expect: 'sudo', blocklist: ['sudo'], command: 'echo ok && sudo ls', note: 'chained' },
  { id: 'ctl_pipe', card: 'B15', group: 'control', shell: 'bash', expect: 'iptables', blocklist: ['iptables'], command: 'echo x | iptables -L', note: 'piped' },
  { id: 'ctl_sub', card: 'B15', group: 'control', shell: 'bash', expect: 'sudo', blocklist: ['sudo'], command: 'echo "$(sudo id)"', note: 'in $() inside double quotes' },
  { id: 'ctl_path', card: 'B15', group: 'control', shell: 'bash', expect: 'sudo', blocklist: ['sudo'], command: '/usr/bin/sudo ls', note: 'path to sudo' },
  { id: 'ctl_net', card: 'B15', group: 'control', shell: 'powershell', expect: 'net', blocklist: ['net'], command: 'net stop Spooler', note: 'plain net' },
  { id: 'ctl_netexe', card: 'B15', group: 'control', shell: 'powershell', os: 'win32', expect: 'net', blocklist: ['net'], command: 'C:\\Windows\\System32\\net.exe user', note: 'net.exe by path; elsewhere that program does not exist, so nothing runs' },
  { id: 'ctl_allow', card: 'B15', group: 'control', shell: 'bash', expect: null, blocklist: ['sudo'], command: 'echo "Hello World"', note: 'plainly safe' },
];
