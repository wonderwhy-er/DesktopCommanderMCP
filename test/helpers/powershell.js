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

/** The PowerShells found on PATH here: Windows PowerShell (powershell) and PowerShell 7 (pwsh), in that order */
export function installedPowerShells() {
  return ['powershell', 'pwsh'].filter((shell) => isShellAvailable(shell));
}

/** Git for Windows' bash, by its full path: bash.exe on PATH can be WSL's */
export const GIT_BASH = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
