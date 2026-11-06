import { spawnSync } from 'child_process';
import path from 'path';
import { resolveShellPath } from '../../dist/utils/shell.js';

/**
 * A PowerShell single-quoted string literal for `value`: the text between single
 * quotes, with every single-quote character doubled. PowerShell expands nothing
 * inside it ($, backticks), and it also takes the typographic quotes ‘ ’ ‚ ‛ as
 * single quotes, so those are doubled too. Use it for every path or text put into
 * a PowerShell command, e.g. `Get-Item -LiteralPath ${psQuote(file)}`.
 */
export function psQuote(value) {
  return `'${String(value).replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&')}'`;
}

let found;

/**
 * The PowerShells here that really run PowerShell: on Windows, Windows PowerShell
 * (powershell) and PowerShell 7 (pwsh), in that order; elsewhere only pwsh, since
 * a program named powershell on a macOS or Linux PATH can be anything, and one
 * placed before pwsh would fail the PowerShell tests before they reached pwsh.
 */
export function installedPowerShells() {
  const names = process.platform === 'win32' ? ['powershell', 'pwsh'] : ['pwsh'];
  // Once present, every candidate must work; a healthy second shell must not hide a broken first one.
  found ??= names.filter((shell) => {
    const program = resolveShellPath(shell);
    return program !== null && answersAsPowerShell(shell, program);
  });
  return [...found];
}

/** Only absence permits a skip. An installed shell that cannot report its version fails the tests. */
function answersAsPowerShell(shell, program) {
  const result = spawnSync(program, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], {
    encoding: 'utf8',
    // A PowerShell can take seconds to start on a loaded machine
    timeout: 30_000,
    windowsHide: true,
  });
  const failure = (reason) => new Error(`PowerShell discovery failed for ${shell}: ${reason}`);
  if (result.error?.code === 'ETIMEDOUT') throw failure('version probe timed out after 30000 ms');
  if (result.error) throw failure(`version probe could not start (${result.error.code ?? result.error.message})`);
  if (result.signal) throw failure(`version probe ended with signal ${result.signal}`);
  if (result.status !== 0) throw failure(`version probe exited with code ${result.status}`);
  if (typeof result.stdout !== 'string' || !/^\d+$/.test(result.stdout.trim())) {
    throw failure('version probe returned a malformed major version');
  }
  return true;
}

/** Git for Windows' bash, by its full path: bash.exe on PATH can be WSL's */
export const GIT_BASH = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
