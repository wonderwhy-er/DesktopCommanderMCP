import { programName, type ShellType } from './shell.js';
import type { FoundCommand } from './command-reading.js';

/**
 * The command check's rules for wrappers: commands that start another
 * program, as env does in "env sudo ls", which runs sudo. checkCommand()
 * follows each wrapper to the program it starts, past the wrapper's own
 * options (timeout 5 reboot, nice -n 10 dd, sudo -u root id), and checks that
 * program like any other command. A wrapper can start another wrapper: env
 * nohup sudo ls runs sudo.
 * - env, nohup, timeout, sudo, strace and the other programs in PROGRAMS
 *   start the program after their options from every shell: chroot after its
 *   new root, busybox its own program of that name, wsl in Linux, find the one
 *   after -exec, tmux the one its new-session starts, and capsh its shell.
 *   env -S 'sudo ls' runs sudo too: env splits -S's text into more of its own
 *   words. Windows' timeout /t 5 starts nothing: it only waits. psexec
 *   \\server sudo ls runs sudo on another computer, which the check leaves
 *   out, as it leaves out ssh's;
 * - exec and command are commands of the POSIX shells;
 * - Start-Process (also written start or saps) is PowerShell's: the PowerShell
 *   reader gives the programs it starts, as PowerShell itself binds its
 *   FilePath (FoundCommand's filePaths);
 * - start is cmd's (cmd's call is the cmd reader's, as if and else are).
 *
 * Where the check can't tell which word is the program, every reading counts,
 * and the check refuses the command when any of them runs a blocked program.
 * An option the rules don't list may take the next word as its value or not
 * (nice -X 10 sudo ls runs 10 or sudo). A word known only at run time where an
 * option could be ($OPTS in nice $OPTS make) may be the program, or an option
 * with or without a value: it is a program known only at run time, and either
 * of the next two words may be the program too. Neither takes a word that is
 * an option itself as its value (in env $OPTS -u sudo ls, -u takes sudo).
 */

/**
 * A wrapper's options. The programs read them with getopt, and the shells
 * read exec's and command's the same way: -abc is -a -b -c, a value follows
 * its option in the same word (-uroot, --user=root) or in the next one (-u
 * root, --user root), a long option may be shortened while it stays
 * unambiguous (--us), and -- ends the options.
 */
interface PosixWrapper {
  /** The one-letter options that take a value */
  letters?: string;
  /** The one-letter options whose value can only be in the same word (xargs -i{}, and nice -10, the old nice -n 10) */
  attachedLetters?: string;
  /** The one-letter options that take no value */
  flags?: string;
  /** The long options that take a value */
  long?: string[];
  /** The long options that take two words: bwrap --bind SRC DEST */
  longPairs?: string[];
  /** The long options that take no value, or one only after = (env --block-signal=PIPE) */
  longFlags?: string[];
  /** Whether its long options are written in full and take a value only after = (firejail --private=dir), so one without = takes none */
  equalsOnly?: boolean;
  /** Whether its options are whole words after one dash, not letters, read as long options (xterm -title, arch -x86_64) */
  wordOptions?: boolean;
  /** Whether an option can also start with +, which turns it off (xterm +sb) */
  plus?: boolean;
  /** The options with which no program runs: command -v sudo only says what sudo is */
  noProgram?: string;
  /** The long options with which no program runs: ionice --pid 1234 changes a running process */
  noProgramLong?: string[];
  /** The first words, in any case, after which no program runs: Windows' timeout /t 5 only waits */
  noProgramWords?: string[];
  /** How many words after the options come before the program: timeout's duration */
  before?: number;
  /** Whether those words may be left out: since util-linux 2.42, chrt -i make needs no priority */
  beforeOptional?: boolean;
  /** Whether NAME=VALUE words before the program set its environment (env, sudo) */
  assignments?: boolean;
  /**
   * The options whose value is a command text: env -S 'sudo ls' and --split-string='sudo ls' run sudo, as env
   * splits the text into more of its own words
   */
  texts?: { letters: string; long: string[] };
  /**
   * The options whose value is the program, which takes the words after -- as its arguments
   * (start-stop-daemon --exec /usr/bin/sudo -- ls), and the program that runs after -- without one (capsh -- -c ls
   * runs bash). The words after the options are no program then.
   */
  programOptions?: { letters?: string; long: string[]; default?: string };
  /**
   * The words after which a program runs, anywhere among its words, and the words that end it (find -exec sudo rm
   * {} ;). Its other words are no program.
   */
  programAfter?: { words: string[]; ends: string[] };
  /** Its own commands that start a program, each with its rules: tmux new-session -d sudo ls */
  subcommands?: Map<string, PosixWrapper>;
  /** How the words that name other computers start: psexec \\server runs its program there, not here */
  remote?: string[];
}

/** tmux's commands that start the program after their options (tmux new-session -d sudo ls), by name and alias */
const TMUX_NEW_SESSION: PosixWrapper = { letters: 'cefFnstxy', flags: 'AdDEPX' };
const TMUX_NEW_WINDOW: PosixWrapper = { letters: 'ceFnt', flags: 'abdEkPS' };
const TMUX_SPLIT_WINDOW: PosixWrapper = { letters: 'BceFlmpRsStT', flags: 'bdEfhIkPvWZ' };
const TMUX_RESPAWN: PosixWrapper = { letters: 'cet', flags: 'Ek' };
const TMUX_COMMANDS = new Map<string, PosixWrapper>([
  ['new-session', TMUX_NEW_SESSION], ['new', TMUX_NEW_SESSION],
  ['new-window', TMUX_NEW_WINDOW], ['neww', TMUX_NEW_WINDOW],
  ['split-window', TMUX_SPLIT_WINDOW], ['splitw', TMUX_SPLIT_WINDOW],
  ['respawn-pane', TMUX_RESPAWN], ['respawnp', TMUX_RESPAWN], ['respawn-window', TMUX_RESPAWN], ['respawnw', TMUX_RESPAWN],
]);

/**
 * The wrappers that are programs, with their options from each one's manual
 * or --help: GNU's, BSD's and macOS's where there are several (and Windows'
 * sudo), util-linux's, systemd's, OpenBSD's doas, polkit's pkexec, and the
 * usage text of busybox, wsl, gsudo and psexec
 */
const PROGRAMS = new Map<string, PosixWrapper>([
  ['env', {
    letters: 'uCPLUa', flags: 'i0v', long: ['unset', 'chdir', 'argv0'],
    longFlags: ['ignore-environment', 'null', 'debug', 'block-signal', 'default-signal', 'ignore-signal', 'list-signal-handling', 'help', 'version'],
    assignments: true, texts: { letters: 'S', long: ['split-string'] },
  }],
  ['nohup', { longFlags: ['help', 'version'] }],
  ['xargs', {
    letters: 'adEIJLnPRSs', attachedLetters: 'eil', flags: '0oprtx',
    long: ['arg-file', 'delimiter', 'max-args', 'max-chars', 'max-lines', 'max-procs', 'process-slot-var'],
    longFlags: ['null', 'eof', 'replace', 'open-tty', 'interactive', 'no-run-if-empty', 'show-limits', 'verbose', 'exit', 'help', 'version'],
  }],
  ['timeout', {
    letters: 'ks', flags: 'fpv', long: ['kill-after', 'signal'], longFlags: ['foreground', 'preserve-status', 'verbose', 'help', 'version'],
    before: 1, noProgramWords: ['/t', '/nobreak'],
  }],
  ['nice', { letters: 'n', attachedLetters: '0123456789', long: ['adjustment'], longFlags: ['help', 'version'] }],
  ['stdbuf', { letters: 'ioe', long: ['input', 'output', 'error'], longFlags: ['help', 'version'] }],
  ['setsid', { flags: 'cfwhV', longFlags: ['ctty', 'fork', 'wait', 'help', 'version'] }],
  ['chroot', { letters: 'Ggu', flags: 'n', long: ['groups', 'userspec'], longFlags: ['skip-chdir', 'help', 'version'], before: 1 }],
  ['sudo', {
    letters: 'aCcDghpRrTtUu', flags: 'ABbEeHiKklNnPSsVv',
    long: ['auth-type', 'chdir', 'chroot', 'close-from', 'command-timeout', 'group', 'host', 'login-class', 'other-user', 'prompt', 'role', 'type', 'user'],
    longFlags: [
      'askpass', 'bell', 'background', 'preserve-env', 'edit', 'set-home', 'help', 'login', 'remove-timestamp', 'reset-timestamp', 'list',
      'no-update', 'non-interactive', 'preserve-groups', 'stdin', 'shell', 'version', 'validate', 'new-window', 'disable-input', 'inline',
    ],
    assignments: true,
  }],
  ['doas', { letters: 'au', flags: 'ns', noProgram: 'CL' }],
  ['pkexec', { long: ['user'], longFlags: ['keep-cwd', 'disable-internal-agent', 'help', 'version'] }],
  ['busybox', { noProgramWords: ['--list', '--list-full', '--install', '--show', '--help'] }],
  ['wsl', { letters: 'du', flags: 'e', long: ['cd', 'distribution', 'distribution-id', 'user', 'shell-type'], longFlags: ['exec', 'system'] }],
  ['nsenter', {
    letters: 'tNGS', attachedLetters: 'muinpUCTrwW', flags: 'aeFZchV', long: ['target', 'net-socket', 'setgid', 'setuid'],
    longFlags: [
      'all', 'mount', 'uts', 'ipc', 'net', 'pid', 'user', 'user-parent', 'cgroup', 'time', 'keep-caps', 'preserve-credentials', 'root',
      'wd', 'wdns', 'env', 'no-fork', 'follow-context', 'join-cgroup', 'help', 'version',
    ],
  }],
  ['unshare', {
    letters: 'lRwSG', attachedLetters: 'imnpuUCT', flags: 'frchV',
    long: [
      'load-interp', 'map-user', 'map-users', 'map-group', 'map-groups', 'owner', 'propagation', 'setgroups', 'root', 'wd', 'setuid',
      'setgid', 'monotonic', 'boottime', 'whitelist-env',
    ],
    longFlags: [
      'ipc', 'mount', 'net', 'pid', 'uts', 'user', 'cgroup', 'time', 'fork', 'forward-signals', 'keep-caps', 'kill-child', 'mount-proc',
      'mount-binfmt', 'map-auto', 'map-subids', 'map-root-user', 'map-current-user', 'clear-env', 'help', 'version',
    ],
  }],
  ['ionice', { letters: 'cn', flags: 'thV', long: ['class', 'classdata'], longFlags: ['ignore', 'help', 'version'], noProgram: 'pPu', noProgramLong: ['pid', 'pgid', 'uid'] }],
  ['taskset', { flags: 'achV', longFlags: ['all-tasks', 'cpu-list', 'help', 'version'], noProgram: 'p', noProgramLong: ['pid'], before: 1 }],
  ['chrt', {
    letters: 'TPDUX', flags: 'ofrbideGORavhV', long: ['sched-runtime', 'sched-period', 'sched-deadline', 'clamp-min', 'clamp-max'],
    longFlags: ['other', 'fifo', 'rr', 'batch', 'idle', 'deadline', 'ext', 'reclaim-grub', 'deadline-overrun', 'reset-on-fork', 'all-tasks', 'verbose', 'help', 'version'],
    noProgram: 'mp', noProgramLong: ['max', 'pid'], before: 1, beforeOptional: true,
  }],
  ['numactl', {
    letters: 'iwmNCpP', flags: 'alb',
    long: ['interleave', 'weighted-interleave', 'membind', 'cpunodebind', 'physcpubind', 'preferred', 'preferred-many', 'offset', 'shmmode', 'length'],
    longFlags: ['all', 'localalloc', 'balancing', 'cpu-compress', 'huge', 'strict', 'touch', 'dump', 'dump-nodes'],
    noProgram: 'sH', noProgramLong: ['show', 'hardware', 'version', 'shm', 'shmid', 'file'],
  }],
  ['prlimit', {
    letters: 'o', attachedLetters: 'cdefilmnqrstuvxy', flags: 'hV', long: ['output'],
    longFlags: [
      'noheadings', 'raw', 'verbose', 'help', 'version', 'core', 'data', 'nice', 'fsize', 'sigpending', 'memlock', 'rss', 'nofile',
      'msgqueue', 'rtprio', 'stack', 'cpu', 'nproc', 'as', 'locks', 'rttime',
    ],
    noProgram: 'p', noProgramLong: ['pid'],
  }],
  ['setpriv', {
    flags: 'hV',
    long: [
      'groups', 'inh-caps', 'ambient-caps', 'bounding-set', 'rgid', 'egid', 'regid', 'ruid', 'euid', 'reuid', 'securebits', 'pdeathsig',
      'ptracer', 'selinux-label', 'apparmor-profile', 'landlock-access', 'landlock-rule', 'seccomp-filter',
    ],
    longFlags: ['clear-groups', 'keep-groups', 'init-groups', 'nnp', 'no-new-privs', 'reset-env', 'help', 'version'],
    noProgram: 'd', noProgramLong: ['dump', 'list-caps'],
  }],
  ['capsh', { equalsOnly: true, programOptions: { long: ['shell'], default: 'bash' } }],
  ['cpulimit', {
    letters: 'lcs', flags: 'bfqkmrvzh', long: ['limit', 'cpu', 'signal'],
    longFlags: ['background', 'foreground', 'quiet', 'kill', 'monitor-forks', 'restore', 'verbose', 'lazy', 'help'],
    noProgram: 'peP', noProgramLong: ['pid', 'exe', 'path'],
  }],
  ['systemd-run', {
    letters: 'upEHMC', flags: 'rdRtTPSqvGh',
    long: [
      'unit', 'property', 'description', 'slice', 'expand-environment', 'service-type', 'uid', 'gid', 'nice', 'working-directory',
      'root-directory', 'setenv', 'output', 'on-active', 'on-boot', 'on-startup', 'on-unit-active', 'on-unit-inactive', 'on-calendar',
      'path-property', 'socket-property', 'timer-property', 'job-mode', 'background', 'host', 'machine', 'capsule', 'json',
    ],
    longFlags: [
      'scope', 'slice-inherit', 'remain-after-exit', 'send-sighup', 'same-dir', 'same-root-dir', 'pty', 'pty-late', 'pipe', 'shell',
      'quiet', 'verbose', 'on-clock-change', 'on-timezone-change', 'no-block', 'wait', 'collect', 'ignore-failure', 'user', 'system',
      'no-ask-password', 'help', 'version', 'no-pager',
    ],
  }],
  ['run0', {
    letters: 'ugD', flags: 'kKinh',
    long: [
      'unit', 'property', 'description', 'slice', 'user', 'group', 'nice', 'chdir', 'setenv', 'background', 'shell-prompt-prefix',
      'lightweight', 'area', 'machine',
    ],
    longFlags: [
      'slice-inherit', 'reset-timestamp', 'remove-timestamp', 'via-shell', 'pty', 'pty-late', 'pipe', 'empower', 'same-root-dir',
      'non-interactive', 'no-ask-password', 'help', 'version',
    ],
    noProgram: 'v', noProgramLong: ['validate'],
  }],
  ['strace', {
    letters: 'eEpubIPaoOsSUX', flags: 'DfcCdhiknNqrtTvVwxyYzZAF',
    long: [
      'env', 'attach', 'user', 'argv0', 'detach-on', 'interruptible', 'syscall-limit', 'trace', 'trace-fds', 'signal', 'status',
      'trace-path', 'columns', 'abbrev', 'verbose', 'raw', 'read', 'write', 'silent', 'silence', 'kvm', 'namespace',
      'stack-trace-frame-limit', 'output', 'color', 'string-limit', 'const-print-style', 'summary-syscall-overhead', 'summary-sort-by',
      'summary-columns', 'inject', 'fault',
    ],
    longFlags: [
      'daemonize', 'follow-forks', 'output-separately', 'kill-on-exit', 'successful-only', 'failed-only', 'quiet', 'decode-fds',
      'decode-pids', 'pidns-translation', 'instruction-pointer', 'syscall-number', 'arg-names', 'stack-trace', 'output-append-mode',
      'relative-timestamps', 'absolute-timestamps', 'timestamps', 'syscall-times', 'no-abbrev', 'strings-in-hex', 'summary-only',
      'summary', 'summary-wall-clock', 'debug', 'help', 'seccomp-bpf', 'tips', 'version', 'always-show-pid', 'secontext',
    ],
  }],
  ['ltrace', {
    letters: 'aAdDeFlnopsuwx', flags: 'bcCfhiLrStTV', long: ['align', 'max-depth', 'debug', 'config', 'library', 'indent', 'output', 'where'],
    longFlags: ['no-signals', 'demangle', 'help', 'version'],
  }],
  ['time', { letters: 'fo', flags: 'paqvV', long: ['format', 'output'], longFlags: ['portability', 'append', 'verbose', 'quiet', 'help', 'version'] }],
  ['firejail', {
    equalsOnly: true, flags: 'c', noProgram: '?',
    noProgramLong: [
      'list', 'tree', 'top', 'netstats', 'nettrace', 'icmptrace', 'dnstrace', 'snitrace', 'version', 'help', 'debug-caps',
      'debug-errnos', 'debug-syscalls', 'debug-syscalls32', 'debug-protocols', 'shutdown', 'bandwidth', 'ids-init', 'ids-check', 'ls',
      'get', 'put', 'cat',
    ],
  }],
  ['bwrap', {
    long: [
      'args', 'userns', 'userns2', 'pidns', 'uid', 'gid', 'hostname', 'chdir', 'unsetenv', 'lock-file', 'sync-fd', 'perms', 'size',
      'remount-ro', 'proc', 'dev', 'tmpfs', 'mqueue', 'dir', 'seccomp', 'add-seccomp-fd', 'exec-label', 'file-label', 'block-fd',
      'userns-block-fd', 'info-fd', 'json-status-fd', 'cap-add', 'cap-drop',
    ],
    longPairs: [
      'setenv', 'bind', 'bind-try', 'dev-bind', 'dev-bind-try', 'ro-bind', 'ro-bind-try', 'file', 'bind-data', 'ro-bind-data', 'symlink',
      'chmod',
    ],
    longFlags: [
      'help', 'version', 'unshare-user', 'unshare-user-try', 'unshare-ipc', 'unshare-pid', 'unshare-net', 'unshare-uts',
      'unshare-cgroup', 'unshare-cgroup-try', 'unshare-all', 'share-net', 'disable-userns', 'assert-userns-disabled', 'clearenv',
      'new-session', 'die-with-parent', 'as-pid-1',
    ],
  }],
  ['unbuffer', { flags: 'p' }],
  ['rlwrap', {
    letters: 'bCDefgHlMOPqsStwz', attachedLetters: 'aAmp', flags: 'cEhiInNorRUvW',
    long: [
      'break-chars', 'command-name', 'history-no-dupes', 'extra-char-after-completion', 'file', 'forget-matching', 'history-filename',
      'logfile', 'multi-line-ext', 'only-cook', 'pre-given', 'quote-characters', 'histsize', 'substitute-prompt', 'set-term-name',
      'wait-before-prompt', 'filter',
    ],
    longFlags: [
      'always-readline', 'ansi-colour-aware', 'complete-filenames', 'always-echo', 'help', 'case-insensitive', 'pass-sigint-as-sigterm',
      'multi-line', 'no-warnings', 'no-children', 'one-shot', 'prompt-colour', 'remember', 'renice', 'mirror-arguments', 'version', 'polling',
    ],
  }],
  ['chpst', { letters: 'uUbe/nlLmdopfct', flags: 'vVP012' }],
  ['setuidgid', { before: 1 }],
  ['start-stop-daemon', {
    letters: 'pnugsRcrdONPIk', flags: 'StoqbCmv',
    long: [
      'pid', 'ppid', 'pidfile', 'name', 'user', 'group', 'signal', 'retry', 'chuid', 'chroot', 'chdir', 'notify-timeout', 'output',
      'nicelevel', 'procsched', 'iosched', 'umask',
    ],
    longFlags: ['start', 'test', 'oknodo', 'quiet', 'background', 'notify-await', 'no-close', 'make-pidfile', 'remove-pidfile', 'verbose'],
    noProgram: 'KTHV', noProgramLong: ['stop', 'status', 'help', 'version'], programOptions: { letters: 'xa', long: ['exec', 'startas'] },
  }],
  ['caffeinate', { letters: 'tw', flags: 'dimsu' }],
  ['arch', { wordOptions: true, long: ['arch', 'd', 'e'], longFlags: ['32', '64', 'i386', 'x86_64', 'x86_64h', 'arm64', 'arm64e', 'c', 'h'] }],
  ['sandbox-exec', { letters: 'fnpD' }],
  ['find', { programAfter: { words: ['-exec', '-execdir', '-ok', '-okdir'], ends: [';', '+'] } }],
  ['parallel', {
    letters: 'aCdEIjJnNPsLS', attachedLetters: 'eil', flags: '0kmqrtuvXx',
    long: [
      'arg-file', 'arg-file-sep', 'arg-sep', 'basefile', 'bf', 'basenamereplace', 'bnr', 'basenameextensionreplace', 'bner', 'bin', 'block',
      'block-size', 'block-timeout', 'bt', 'colsep', 'combineexec', 'compress-program', 'decompress-program', 'delay', 'delimiter',
      'dirnamereplace', 'dnr', 'env', 'extensionreplace', 'er', 'filter', 'group-by', 'halt', 'halt-on-error', 'header', 'jobs',
      'max-procs', 'joblog', 'jl', 'limit', 'load', 'match', 'max-args', 'max-chars', 'max-replace-args', 'memfree', 'memsuspend',
      'milestone', 'minversion', 'nice', 'parens', 'process-slot-var', 'profile', 'recend', 'recstart', 'results', 'res', 'retries',
      'return', 'rpl', 'rsync-opts', 'sshlogin', 'sshloginfile', 'tagstring', 'timeout', 'tmpdir', 'workdir', 'wd',
    ],
    longFlags: [
      'eof', 'max-lines', 'keep-order', 'tag', 'dry-run', 'pipe', 'group', 'ungroup', 'line-buffer', 'progress', 'eta', 'bar', 'verbose',
      'null', 'quote', 'no-run-if-empty', 'shuf', 'tty', 'xargs', 'cleanup', 'transfer', 'help', 'version',
    ],
  }],
  ['xterm', {
    wordOptions: true, plus: true,
    long: [
      'b', 'bcf', 'bcn', 'bd', 'bg', 'bw', 'cc', 'class', 'cr', 'display', 'en', 'fa', 'fb', 'fc', 'fd', 'fg', 'fi', 'fn', 'font', 'fs', 'fw',
      'fwb', 'fx', 'geometry', 'hc', 'into', 'kt', 'lcc', 'lf', 'mc', 'ms', 'n', 'name', 'nb', 'pf', 'selbg', 'selfg', 'sh', 'sl', 'ti',
      'title', 'tm', 'tn', 'T', 'w', 'xrm', 'ziconbeep', 'baudrate',
    ],
    longFlags: [
      'e', 'ah', 'aw', 'bc', 'cb', 'cjk_width', 'cm', 'cn', 'cu', 'dc', 'fbb', 'fbx', 'fullscreen', 'hf', 'hm', 'hold', 'ie', 'im', 'itc',
      'j', 'k8', 'l', 'lc', 'leftbar', 'ls', 'maximized', 'mb', 'mesg', 'mk_width', 'nul', 'pc', 'pob', 'rightbar', 'rv', 'rvc', 'rw', 's',
      'samename', 'sb', 'sf', 'si', 'sk', 'sm', 'sp', 't', 'tb', 'toolbar', 'u8', 'ulc', 'ulit', 'ut', 'vb', 'wc', 'wf', 'iconic',
      'reverse', 'help', 'version',
    ],
  }],
  ['tmux', { letters: 'cfLST', flags: '2CDhlNuVv', subcommands: TMUX_COMMANDS }],
  ['screen', { letters: 'cehpsStT', flags: 'aAdDfiLlmOPqRU', noProgram: 'rxXQv', noProgramWords: ['-ls', '-list', '-wipe'] }],
  ['gsudo', {
    letters: 'ui', flags: 'nwskd', long: ['user', 'integrity', 'loglevel', 'chdir'],
    longFlags: ['new', 'wait', 'keepShell', 'keepWindow', 'system', 'ti', 'direct', 'loadProfile', 'debug', 'copyns', 'copyev'],
  }],
  ['psexec', {
    wordOptions: true, long: ['u', 'p', 'n', 'r', 'w', 'a', 'g'],
    longFlags: [
      's', 'e', 'h', 'l', 'x', 'c', 'f', 'v', 'd', 'accepteula', 'nobanner', 'low', 'belownormal', 'abovenormal', 'high', 'realtime',
      'background',
    ],
    remote: ['\\\\', '@'],
  }],
]);

/** The POSIX shells' own commands that start a program */
const POSIX_SHELL_COMMANDS = new Map<string, PosixWrapper>([
  ['exec', { letters: 'a', flags: 'cl' }],
  ['command', { flags: 'p', noProgram: 'vV' }],
]);

/** cmd's start switches that take the next word as their value (/D also takes it in the same word: /Dpath) */
const CMD_START_VALUE_SWITCHES = ['/d', '/node', '/affinity', '/machine'];

/** A program a wrapper starts: its words as the shell reads them, as written and as texts, the name first */
type Started = Pick<FoundCommand, 'words' | 'written' | 'wordTexts'>;

/**
 * The commands that run: each of `commands`, followed by the programs that
 * the wrappers among them start (for env sudo ls: env, then sudo). A started
 * program has its wrapper's start.
 */
export function withStartedPrograms(commands: FoundCommand[], shellType: ShellType): FoundCommand[] {
  const running: FoundCommand[] = [];
  const add = (command: FoundCommand): void => {
    running.push(command);
    if (command.nameAtRunTime) return;
    for (const { words, written, wordTexts } of startedPrograms(command, shellType)) {
      add({ name: words[0] ?? written[0], words, written, wordTexts, start: command.start, nameAtRunTime: words[0] === null });
    }
  };
  commands.forEach(add);
  return running;
}

/** The programs a command starts when it is a wrapper: none for any other command */
function startedPrograms(command: FoundCommand, shellType: ShellType): Started[] {
  const name = programName(command.name);
  const { words, written, wordTexts } = command;
  const from = (at: number): Started => ({ words: words.slice(at), written: written.slice(at), wordTexts: wordTexts.slice(at) });
  const posix = PROGRAMS.get(name) ?? (shellType === 'posix' ? POSIX_SHELL_COMMANDS.get(name) : undefined);
  if (posix) return posixPrograms(command, posix);
  // Its own arguments are in -ArgumentList, a text the check doesn't read, so a program Start-Process starts has only its name
  if (shellType === 'powershell' && name === 'start-process') return (command.filePaths ?? []).map(({ word, written }) => ({ words: [word], written: [written], wordTexts: [word ?? written] }));
  if (shellType === 'cmd' && name === 'start') return cmdStartProgramsAt(command).map(from);
  return [];
}

/**
 * The programs a POSIX wrapper starts: its words from each place the program
 * can be. env -S puts the words of its text in its own place and reads them as
 * env's words, followed by the words after the text (env -S ls sudo runs ls).
 */
function posixPrograms({ words, written, wordTexts }: Started, rules: PosixWrapper): Started[] {
  // Windows' timeout /t 5 only waits, and GNU's timeout stops with an error at /t, which is no duration
  const first = words[1];
  if (first && rules.noProgramWords?.includes(first.toLowerCase())) return [];
  const from = (i: number, end = words.length): Started => ({ words: words.slice(i, end), written: written.slice(i, end), wordTexts: wordTexts.slice(i, end) });
  const after = rules.programAfter;
  if (after) {
    // find -exec sudo rm {} ;: each program runs from the word after -exec up to ;
    return words.flatMap((word, i) => {
      if (word === null || !after.words.includes(word)) return [];
      const end = words.findIndex((next, j) => j > i && next !== null && after.ends.includes(next));
      const stop = end === -1 ? words.length : end;
      return stop > i + 1 ? [from(i + 1, stop)] : [];
    });
  }
  const { operands, texts, programs: named } = readOptions(words, rules);
  if (rules.programOptions) {
    // The program an option names, or the one that runs without it, takes the words after -- as its arguments
    const end = words.indexOf('--');
    const args = end === -1 ? words.length : end + 1;
    const fallback = rules.programOptions.default;
    const runs = named.length > 0 ? named : end !== -1 && fallback ? [{ program: fallback }] : [];
    return runs.map(({ program, at }) => ({
      words: [program, ...words.slice(args)],
      written: [at === undefined ? program ?? '' : written[at], ...written.slice(args)],
      wordTexts: [at === undefined ? program ?? '' : wordTexts[at], ...wordTexts.slice(args)],
    }));
  }
  // psexec \\server sudo ls runs sudo on another computer
  const remote = (i: number): boolean => words.slice(1, i + 1).some((word) => rules.remote?.some((start) => word?.startsWith(start)));
  const at = new Set<number>();
  for (let i of operands) {
    // After the options: the NAME=VALUE settings, then the words before the program, which chrt may leave out
    while (rules.assignments && i < words.length && (words[i] ?? written[i]).includes('=')) i++;
    if (rules.beforeOptional && i < words.length) at.add(i);
    i += rules.before ?? 0;
    if (i < words.length && !remote(i)) at.add(i);
  }
  // A command of the program's own, such as tmux new-session, reads its words by its own rules
  const programs = [...at].flatMap((i) => {
    const subcommand = subcommandOf(words[i], rules);
    return subcommand ? posixPrograms(from(i), subcommand) : [from(i)];
  });
  // A wrapper's command text is more of its own words, split as env splits -S's: env is the one wrapper with one
  return [...programs, ...texts.flatMap(({ text, after }) => {
    const split = envSplitWords(text);
    return posixPrograms({
      words: [words[0], ...split.words, ...words.slice(after)],
      written: [written[0], ...split.written, ...written.slice(after)],
      wordTexts: [wordTexts[0], ...split.wordTexts, ...wordTexts.slice(after)],
    }, rules);
  })];
}

/** Where a program's options end, in each way they can be read, and the command texts and programs they give */
interface OptionReadings {
  /** The first word after the options, in each reading */
  operands: number[];
  /** Each command text an option gives, and the first word after it */
  texts: { text: string; after: number }[];
  /** Each program an option names (start-stop-daemon --exec), null when known only at run time; `at` is its word, unless it is in the option's own */
  programs: { program: string | null; at?: number }[];
}

/**
 * Reads a program's options by its rules, in every way they can be read: an
 * option the rules don't list, and a word known only at run time, may take the
 * next word as its value or not, though not a word that is an option itself.
 * A command text known only at run time (env -S "$CMD") is read on as a word
 * known only at run time.
 */
function readOptions(words: (string | null)[], rules: PosixWrapper): OptionReadings {
  const readings: OptionReadings = { operands: [], texts: [], programs: [] };
  const read = new Set<number>();
  const isOption = (word: string | null | undefined): word is string =>
    typeof word === 'string' && (word.startsWith('-') || (rules.plus === true && word.length > 1 && word.startsWith('+')));
  const readFrom = (i: number): void => {
    if (read.has(i)) return;
    read.add(i);
    const word = words[i];
    if (word === null) {
      // An option with or without a value, or the first word after them
      readings.operands.push(i);
      readFrom(i + 1);
      if (!isOption(words[i + 1])) readFrom(i + 2);
      return;
    }
    if (!isOption(word)) {
      readings.operands.push(i);
      return;
    }
    if (word === '--') {
      readings.operands.push(i + 1);
      return;
    }
    for (const reading of optionReadings(word, rules)) {
      if (reading === null) continue;
      // A value the rules don't know of isn't a word that is an option itself
      if (reading.uncertain && reading.next > 0 && isOption(words[i + reading.next])) continue;
      if (reading.program !== undefined) {
        const at = reading.next === 1 ? i + 1 : undefined;
        const program = at === undefined ? reading.program : words[at];
        if (program !== undefined) readings.programs.push({ program, at });
        readFrom(i + 1 + reading.next);
        continue;
      }
      if (reading.text === undefined) {
        readFrom(i + 1 + reading.next);
        continue;
      }
      const text = reading.next === 1 ? words[i + 1] : reading.text;
      if (text === null) readFrom(i + 1);
      else if (text !== undefined) readings.texts.push({ text, after: i + 1 + reading.next });
    }
  };
  readFrom(1);
  return readings;
}

/** One way to read an option word */
interface OptionReading {
  /** How many of the next words are its value */
  next: number;
  /** Whether it is the reading that an option the rules don't list takes a value */
  uncertain?: true;
  /** For an option whose value is a command text: the text in the same word, or '' when it is the next word */
  text?: string;
  /** For an option whose value is the program: the program in the same word, or '' when it is the next word */
  program?: string;
}

/**
 * The ways to read an option word, null for one with which no program runs.
 * An option that takes a value takes the rest of the word (-uroot,
 * --user=root), or the next word when the rest is empty. One the rules don't
 * list may take a value or not, so it has both readings. A lone - is an
 * option too: env's -i.
 */
function optionReadings(option: string, rules: PosixWrapper): (OptionReading | null)[] {
  const long = option.startsWith('--') ? option.slice(2) : rules.wordOptions ? option.slice(1) : undefined;
  if (long !== undefined) {
    const equals = long.indexOf('=');
    const name = longOption(equals === -1 ? long : long.slice(0, equals), rules);
    if (name !== undefined && rules.noProgramLong?.includes(name)) return [null];
    const isText = name !== undefined && rules.texts?.long.includes(name);
    const isProgram = name !== undefined && rules.programOptions?.long.includes(name);
    const value = long.slice(equals + 1);
    if (equals !== -1) return [isText ? { next: 0, text: value } : isProgram ? { next: 0, program: value } : { next: 0 }];
    if (rules.equalsOnly) return [{ next: 0 }];
    if (name === undefined) return [{ next: 0 }, { next: 1, uncertain: true }];
    if (isText) return [{ next: 1, text: '' }];
    if (isProgram) return [{ next: 1, program: '' }];
    return [{ next: rules.longPairs?.includes(name) ? 2 : rules.long?.includes(name) ? 1 : 0 }];
  }
  const readings: (OptionReading | null)[] = [];
  for (let i = 1; i < option.length; i++) {
    const letter = option[i];
    const value: OptionReading = i === option.length - 1 ? { next: 1 } : { next: 0 };
    if (rules.noProgram?.includes(letter)) return [...readings, null];
    if (rules.texts?.letters.includes(letter)) return [...readings, { ...value, text: option.slice(i + 1) }];
    if (rules.programOptions?.letters?.includes(letter)) return [...readings, { ...value, program: option.slice(i + 1) }];
    if (rules.attachedLetters?.includes(letter)) return [...readings, { next: 0 }];
    if (rules.letters?.includes(letter)) return [...readings, value];
    // An option the rules don't list may take a value, and the next letters read on as if it takes none
    if (!rules.flags?.includes(letter)) readings.push({ ...value, uncertain: true });
  }
  return [...readings, { next: 0 }];
}

/** The long option a name means: the one it names, or the only one it shortens */
function longOption(name: string, rules: PosixWrapper): string | undefined {
  const long = [
    ...rules.long ?? [], ...rules.longPairs ?? [], ...rules.longFlags ?? [], ...rules.noProgramLong ?? [],
    ...rules.texts?.long ?? [], ...rules.programOptions?.long ?? [],
  ];
  if (long.includes(name)) return name;
  // firejail and capsh know their long options only in full
  if (rules.equalsOnly) return undefined;
  const shortened = long.filter((known) => known.startsWith(name));
  return shortened.length === 1 ? shortened[0] : undefined;
}

/** The command of the program's own that a word names: the one it names, or the one it shortens (tmux new-s) */
function subcommandOf(word: string | null | undefined, rules: PosixWrapper): PosixWrapper | undefined {
  if (!word || !rules.subcommands) return undefined;
  const named = rules.subcommands.get(word);
  if (named) return named;
  const shortened = new Set([...rules.subcommands].filter(([name]) => name.startsWith(word)).map(([, subcommand]) => subcommand));
  return shortened.size === 1 ? [...shortened][0] : undefined;
}

/** What a backslash escape in env -S's text gives, besides the character after the backslash */
const ENV_ESCAPES: Record<string, string> = { f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', _: ' ' };

/**
 * The words env makes of -S's text, as GNU's and BSD's env split it: spaces,
 * tabs and \_ between words; '…' and "…" keep a word together, and in '…'
 * only \\ and \' are escapes; a backslash escape gives its character (\t a
 * tab, \_ a space inside "…"), and \c ends the text; a # that starts a word
 * starts a comment; and env fills in ${NAME} at run time, so its word is known
 * only then. Where env would stop with an error, nothing runs, so the text is
 * read as well as it can be.
 */
function envSplitWords(text: string): Started {
  const split: Started = { words: [], written: [], wordTexts: [] };
  // The word being read: undefined between words, null when known only at run time
  let word: string | null | undefined;
  // Its text, with ${NAME} as written
  let wordText = '';
  let start = 0;
  let quote = '';
  const add = (chars: string | null, at: number, asText = chars ?? ''): void => {
    if (word === undefined) {
      word = '';
      wordText = '';
      start = at;
    }
    word = word === null || chars === null ? null : word + chars;
    wordText += asText;
  };
  const end = (at: number): void => {
    if (word === undefined) return;
    split.words.push(word);
    split.written.push(text.slice(start, at));
    split.wordTexts.push(wordText);
    word = undefined;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote === "'") {
      if (char === "'") quote = '';
      else if (char === '\\' && (text[i + 1] === '\\' || text[i + 1] === "'")) add(text[++i], i - 1);
      else add(char, i);
      continue;
    }
    if (char === '\\') {
      const escaped = text[++i];
      if (escaped === undefined || escaped === 'c') {
        end(i - 1);
        return split;
      }
      if (escaped === '_' && !quote) end(i - 1);
      else add(ENV_ESCAPES[escaped] ?? escaped, i - 1);
      continue;
    }
    if (char === quote) {
      quote = '';
      continue;
    }
    if (!quote && (char === '"' || char === "'")) {
      quote = char;
      add('', i);
      continue;
    }
    const close = char === '$' && text[i + 1] === '{' ? text.indexOf('}', i) : -1;
    if (close !== -1) {
      add(null, i, text.slice(i, close + 1));
      i = close;
      continue;
    }
    if (!quote && ' \t\n\v\f\r'.includes(char)) {
      end(i);
      continue;
    }
    // A comment, to the end of the text
    if (!quote && char === '#' && word === undefined) break;
    add(char, i);
  }
  end(text.length);
  return split;
}

/**
 * Where the program cmd's start starts can be: after its switches and its
 * window title, the first word in quotes. A word with %VAR% in it may be a
 * switch or the program: it counts, and so does the next word.
 */
function cmdStartProgramsAt({ words, written }: FoundCommand): number[] {
  const at: number[] = [];
  let title = false;
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (!title && written[i].startsWith('"')) {
      title = true;
      continue;
    }
    if (word?.startsWith('/')) {
      if (CMD_START_VALUE_SWITCHES.includes(word.toLowerCase())) i++;
      continue;
    }
    at.push(i);
    if (word !== null) break;
  }
  return at;
}
