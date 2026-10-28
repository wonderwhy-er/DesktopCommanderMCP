import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Single source of truth for shells: which shell is the default on this
 * machine, which shells are installed, and how to invoke each of them.
 * Config defaults, system info, process tools, the terminal manager and the
 * config editor all derive their shell choices from here.
 */

// Shell executables Windows can host. Which of them exist is resolved on PATH.
const WINDOWS_SHELLS = ['powershell.exe', 'pwsh.exe', 'cmd.exe', 'bash.exe'];

function isWindows(): boolean {
  return os.platform() === 'win32';
}

function isExecutableFile(filePath: string): boolean {
  try {
    fs.accessSync(filePath, isWindows() ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    // Missing or not executable: this candidate isn't a usable shell, the next one is tried
    return false;
  }
}

function windowsExecutableExtensions(): string[] {
  const fromEnv = (process.env.PATHEXT ?? '').split(';').map((ext) => ext.trim()).filter(Boolean);
  return [...new Set(['.EXE', ...fromEnv])];
}

/**
 * Resolves a shell or other program name ("pwsh", "bash.exe", "where") or path
 * ("/bin/zsh") to an executable file. Bare names are searched in PATH's
 * folders only, never the working folder. Returns null when it can't be found.
 */
export function resolveShellPath(shell: string): string | null {
  const name = shell.trim();
  if (!name) return null;

  if (path.isAbsolute(name) || name.includes('/') || name.includes('\\')) {
    return isExecutableFile(name) ? name : null;
  }

  const extensions = isWindows() && !path.extname(name) ? windowsExecutableExtensions() : [''];
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter)
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);

  for (const dir of pathDirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, name + ext);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

export function isShellAvailable(shell: string): boolean {
  return resolveShellPath(shell) !== null;
}

/**
 * The full path to start a program by: the one found on PATH. Windows looks
 * for a bare name ("powershell.exe", "cmd", "tasklist") in the working folder
 * before PATH, so a file of that name there would run instead; every program
 * Desktop Commander starts by name goes through here. On Windows a bare name
 * not found on PATH is an error rather than a name Windows would look up in
 * the working folder. A path (absolute, or with a folder in it) is kept as
 * given, and so is a bare name elsewhere, where the working folder isn't searched.
 */
export function resolveProgramPath(program: string): string {
  const resolved = resolveShellPath(program);
  if (resolved) return resolved;
  const name = program.trim();
  if (isWindows() && !name.includes('/') && !name.includes('\\')) {
    throw new Error(`${name} was not found on PATH`);
  }
  return program;
}

/**
 * Standard Windows PATHEXT value, used to repair a corrupted PATHEXT before
 * running a command.
 *
 * On some Windows Claude Desktop / DXT launches the server process inherits a
 * broken PATHEXT (observed as ".CPL" only). Because commands get the server's
 * environment, that broken value would propagate into every spawned shell,
 * stripping ".EXE" and breaking resolution of git / node / python / rg / etc.
 * (and even full-path .exe invocations under PowerShell). See issue #481.
 */
const STANDARD_PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC';

/**
 * Return a healthy PATHEXT for spawned Windows shells.
 * - Unset           -> use the standard list.
 * - Missing ".EXE"  -> corrupted; merge the standard list with whatever was
 *                      present (preserves any extra extensions, order-stable).
 * - Otherwise       -> leave the inherited value untouched.
 */
function getRepairedPathExt(): string {
  const current = process.env.PATHEXT;
  if (!current) return STANDARD_PATHEXT;
  const exts = current.split(';').map(e => e.trim().toUpperCase()).filter(Boolean);
  if (!exts.includes('.EXE')) {
    return [...new Set([...STANDARD_PATHEXT.split(';'), ...exts])].join(';');
  }
  return current;
}

/**
 * The environment for what Desktop Commander runs for the AI (start_process
 * commands, node:local code): the server's own, with on Windows what a
 * client's launch broke or left out put back. PATHEXT is repaired (#481).
 * ProgramData is set when missing: a client on the MCP SDK's default
 * environment leaves it out, and Windows OpenSSH (ssh, scp, sftp, ssh-keygen)
 * exits 255 without a word when it's unset (#702). Windows keeps it on the
 * system drive, which the SDK's set does pass (SystemDrive, else SystemRoot's
 * drive); with neither it stays unset.
 */
export function getCommandEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (isWindows()) {
    env.PATHEXT = getRepairedPathExt();
    // process.env ignores the name's case on Windows; the copy doesn't, so it's read here
    const drive = process.env.SystemDrive || path.win32.parse(process.env.SystemRoot ?? '').root;
    if (!process.env.ProgramData && drive) {
      env.ProgramData = path.win32.join(drive, '\\', 'ProgramData');
    }
  }
  return env;
}

/**
 * The shell used when the user hasn't configured one.
 * Windows: Windows PowerShell, falling back to %ComSpec%.
 * macOS/Linux: $SHELL, falling back to the OS default shell.
 */
export function getDefaultShell(): string {
  if (isWindows()) {
    if (isShellAvailable('powershell.exe')) return 'powershell.exe';
    return process.env.ComSpec || 'cmd.exe';
  }

  const userShell = process.env.SHELL;
  if (userShell && isShellAvailable(userShell)) return userShell;

  // $SHELL may be unset when launched from a GUI app such as Claude Desktop.
  // zsh is the macOS default since Catalina; /bin/sh is guaranteed by POSIX.
  return os.platform() === 'darwin' ? '/bin/zsh' : '/bin/sh';
}

// Login programs /etc/shells can list that don't run a command given with -c,
// the way every command here starts: terminal multiplexers (screen, tmux),
// git-shell (git commands only), and programs that refuse a login
const NOT_COMMAND_SHELLS = new Set(['nologin', 'false', 'true', 'sync', 'git-shell', 'screen', 'tmux']);

function readEtcShells(): string[] {
  try {
    return fs.readFileSync('/etc/shells', 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .filter((line) => !NOT_COMMAND_SHELLS.has(path.basename(line)));
  } catch {
    // Best-effort discovery only: no readable /etc/shells means no extra shells to list
    return [];
  }
}

/**
 * Shells installed on this machine, default shell first. Only shells that
 * resolve to an executable are returned.
 */
export function detectAvailableShells(): string[] {
  const shells = new Set<string>();
  const add = (shell: string | undefined): void => {
    const value = shell?.trim();
    if (value && isShellAvailable(value)) shells.add(value);
  };

  add(getDefaultShell());
  if (isWindows()) {
    WINDOWS_SHELLS.forEach(add);
  } else {
    add(process.env.SHELL);
    readEtcShells().forEach(add);
  }
  return [...shells];
}

/**
 * A program's name without its folder or extension (one of PATHEXT's, or
 * .ps1), lowercased: C:\Windows\System32\NET.EXE is "net". The command check
 * matches blockedCommands with it.
 */
export function programName(name: string): string {
  const base = path.basename(name).toLowerCase();
  const extension = path.extname(base);
  const known = [...windowsExecutableExtensions(), '.ps1'].some((ext) => ext.toLowerCase() === extension);
  return extension && known ? base.slice(0, -extension.length) : base;
}

/** The kinds of shell a command can run in. The command check has a reader for each. */
export type ShellType = 'posix' | 'powershell' | 'cmd';

/**
 * Which kind of shell a shell program is, by its name without folder and
 * lowercased, as getShellSpawnArgs() reads it: pwsh and powershell (with or
 * without .exe) are PowerShell, cmd and cmd.exe are cmd, and every other shell
 * (bash, zsh, sh, dash, ksh, fish) is POSIX. getShellSpawnArgs() starts each
 * kind its own way.
 */
export function getShellType(shell: string): ShellType {
  const name = path.basename(shell).toLowerCase();
  if (['pwsh', 'pwsh.exe', 'powershell', 'powershell.exe'].includes(name)) return 'powershell';
  if (name === 'cmd' || name === 'cmd.exe') return 'cmd';
  return 'posix';
}

/**
 * The shell start_process runs a command in: the one asked for, else the
 * defaultShell setting, else this machine's default. The command check reads
 * the command with the same shell.
 */
export function getCommandShell(shell: string | undefined, defaultShell: string | undefined): string {
  return shell || defaultShell || getDefaultShell();
}

/**
 * Configuration for spawning a shell with appropriate flags
 */
export interface ShellSpawnConfig {
  executable: string;
  args: string[];
  useShellOption: string | boolean;
  // When true, pass args verbatim on Windows (see executeCommand). Only cmd.exe
  // needs this; its quote parsing conflicts with libuv's default \" escaping.
  windowsVerbatim?: boolean;
}

/**
 * Get the appropriate spawn configuration for a given shell
 * This handles login shell flags for different shell types
 */
export function getShellSpawnArgs(shellPath: string, command: string): ShellSpawnConfig {
  const shellName = path.basename(shellPath).toLowerCase();
  const executable = resolveProgramPath(shellPath);

  // Unix shells with login flag support
  if (shellName.includes('bash') || shellName.includes('zsh')) {
    return {
      executable,
      args: ['-l', '-c', command],
      useShellOption: false
    };
  }

  // PowerShell Core (cross-platform, supports -Login)
  if (shellName === 'pwsh' || shellName === 'pwsh.exe') {
    return {
      executable,
      args: ['-Login', '-Command', command],
      useShellOption: false
    };
  }

  // Windows PowerShell 5.1 (no login flag support)
  if (shellName === 'powershell' || shellName === 'powershell.exe') {
    return {
      executable,
      args: ['-Command', command],
      useShellOption: false
    };
  }

  // CMD
  if (shellName === 'cmd' || shellName === 'cmd.exe') {
    return {
      executable,
      args: ['/c', command],
      windowsVerbatim: true,
      useShellOption: false
    };
  }

  // Fish shell (uses -l for login, -c for command)
  if (shellName.includes('fish')) {
    return {
      executable,
      args: ['-l', '-c', command],
      useShellOption: false
    };
  }

  // Unknown/other shells - use shell option for safety
  // This provides a fallback for shells we don't explicitly handle
  return {
    executable: command,
    args: [],
    useShellOption: executable
  };
}
