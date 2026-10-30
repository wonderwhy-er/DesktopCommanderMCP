import { spawnSync } from 'child_process';
import path from 'path';
import { isShellAvailable } from '../../dist/utils/shell.js';

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
  found ??= names.filter((shell) => isShellAvailable(shell) && answersAsPowerShell(shell));
  return [...found];
}

/** True when the shell runs a PowerShell command: it prints PowerShell's major version */
function answersAsPowerShell(shell) {
  const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], {
    encoding: 'utf8',
    // A PowerShell can take seconds to start on a loaded machine
    timeout: 30_000,
    windowsHide: true,
  });
  return result.status === 0 && /^\d+$/.test(result.stdout.trim());
}

/** Git for Windows' bash, by its full path: bash.exe on PATH can be WSL's */
export const GIT_BASH = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
