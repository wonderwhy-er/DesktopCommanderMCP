import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import type { BraceSemantics } from './brace-expansion.js';

/** Captured at server import, before a command can change cwd, PATH or startup variables. */
const launchCwd = fs.realpathSync(process.cwd());
const launchPathValue = process.env.PATH ?? '';
const launchEnv = { ...process.env };
const launchPath = launchPathValue.split(path.delimiter)
  .map((folder) => path.resolve(launchCwd, folder));
// process.env is case-insensitive on Windows; its plain-object copy is not.
for (const name of Object.keys(launchEnv)) if (name.toLowerCase() === 'path') delete launchEnv[name];
launchEnv.PATH = launchPath.join(path.delimiter);
delete launchEnv.BASH_ENV;
delete launchEnv.ENV;
delete launchEnv.ZDOTDIR;

type Endpoint = { file: string; semantics?: Promise<BraceSemantics | undefined> };
const endpoints = new Map<string, Endpoint>();
const aliases = new Map<string, Endpoint | undefined>();
const names = process.platform === 'win32' ? ['bash.exe', 'zsh.exe'] : ['bash', 'zsh'];
const key = (file: string): string => process.platform === 'win32' ? file.toLowerCase() : file;

/** A script named bash is not a native capability endpoint, even on the launch PATH. */
function nativeFile(file: string): string | undefined {
  let descriptor: number | undefined;
  try {
    const real = fs.realpathSync(file);
    if (!fs.statSync(real).isFile()) return undefined;
    fs.accessSync(real, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    descriptor = fs.openSync(real, 'r');
    const header = Buffer.alloc(4);
    if (fs.readSync(descriptor, header, 0, 4, 0) !== 4) return undefined;
    const magic = header.toString('hex');
    return magic.startsWith('4d5a') || ['7f454c46', 'feedface', 'feedfacf', 'cefaedfe',
      'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic) ? real : undefined;
  } catch {
    // Missing or unreadable endpoints cannot supply a native capability; preserve the legacy reading.
    return undefined;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function capture(file: string): Endpoint | undefined {
  const real = nativeFile(file);
  if (real === undefined) return undefined;
  let endpoint = endpoints.get(key(real));
  if (endpoint === undefined) {
    if (endpoints.size >= 32) return undefined;
    endpoint = { file: real };
    endpoints.set(key(real), endpoint);
  }
  aliases.set(key(file), endpoint);
  aliases.set(key(real), endpoint);
  return endpoint;
}

function isLaunchExecutable(file: string): boolean {
  try {
    fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    // A missing or inaccessible PATH entry cannot be the executable selected at launch.
    return false;
  }
}

// Bare names bind to the FIRST launch-PATH executable, including an unsupported script.
for (const name of names) {
  let first = true;
  for (const folder of launchPath) {
    const file = path.join(folder, name);
    if (!isLaunchExecutable(file)) continue;
    const endpoint = capture(file);
    if (first) aliases.set(key(name), endpoint);
    first = false;
  }
}
const standards = process.platform === 'win32'
  ? [path.join(launchEnv.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(launchEnv.ProgramFiles ?? 'C:\\Program Files', 'Git', 'usr', 'bin', 'bash.exe')]
  : ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash',
    '/bin/zsh', '/usr/bin/zsh', '/usr/local/bin/zsh', '/opt/homebrew/bin/zsh'];
for (const file of standards) capture(file);

/**
 * Fixed --version only, on a matching precaptured native endpoint; never caller code or a profile.
 * Native Bash5.2 retains the backslash slot that Bash5.3 omits; other Bash4/5 calls keep legacy rules.
 * Bash3.2 and Zsh5.9 defaults remain supported; startup options and profiles are not evaluated.
 * One bounded query per endpoint (at most32); unknown, unavailable or other versions retain legacy behavior.
 */
export function posixBraceSemantics(shell: string): Promise<BraceSemantics | undefined> {
  const bare = !shell.includes('/') && !shell.includes('\\');
  const endpoint = aliases.get(key(bare ? shell : path.resolve(launchCwd, shell)));
  if (endpoint === undefined) return Promise.resolve(undefined);
  endpoint.semantics ??= new Promise((resolve) => {
    execFile(endpoint.file, ['--version'], { cwd: launchCwd, env: launchEnv, timeout: 1000,
      maxBuffer: 4096, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
      if (error) return resolve(undefined);
      const version = /^GNU bash, version (\d+)\.(\d+)(?:\D|$)/.exec(stdout);
      if (version?.[1] === '3' && version[2] === '2') return resolve('bash3');
      if (version?.[1] === '5' && version[2] === '2') return resolve('bash5.2');
      if (version && ['4', '5'].includes(version[1])) return resolve('legacy');
      if (/^zsh 5\.9(?:\D|$)/.test(stdout)) return resolve('zsh');
      resolve(undefined);
    });
  });
  return endpoint.semantics;
}
