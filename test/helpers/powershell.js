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
const POWERSHELL_PROBE_TIMEOUT_MS = 30_000;

/**
 * Unresolved executables are omitted so each caller keeps its missing-tool policy.
 * A resolved executable whose version probe fails throws instead of becoming a skip.
 * Windows checks powershell then pwsh; elsewhere only pwsh, because powershell on
 * a POSIX PATH can be an unrelated program rather than Windows PowerShell.
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

/** Probe failures must fail the caller, rather than masquerade as a missing interpreter. */
function answersAsPowerShell(shell, program) {
  const probeOutput = spawnSync(program, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major',
  ], {
    encoding: 'utf8',
    // A PowerShell can take seconds to start on a loaded machine
    timeout: POWERSHELL_PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
  const failure = (reason) => new Error(`PowerShell discovery failed for ${shell}: ${reason}`);
  if (probeOutput.error?.code === 'ETIMEDOUT') {
    throw failure(`version probe timed out after ${POWERSHELL_PROBE_TIMEOUT_MS} ms`);
  }
  if (probeOutput.error) {
    throw failure(`version probe could not start (${probeOutput.error.code ?? probeOutput.error.message})`);
  }
  if (probeOutput.signal) throw failure(`version probe ended with signal ${probeOutput.signal}`);
  if (probeOutput.status !== 0) throw failure(`version probe exited with code ${probeOutput.status}`);
  if (typeof probeOutput.stdout !== 'string' || !/^\d+$/.test(probeOutput.stdout.trim())) {
    throw failure('version probe returned a malformed major version');
  }
  return true;
}

/** Git for Windows' bash, by its full path: bash.exe on PATH can be WSL's */
export const GIT_BASH = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
