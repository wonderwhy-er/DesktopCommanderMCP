/**
 * The Docker installers' own steps for tests. Like test/remote-launchers.test.js
 * with the launchers, each run uses a temporary copy of the installer in which
 * the test's values replace the installer's own, so the installers carry no
 * lines for the tests: install-docker.sh up to its main part, sourced in bash,
 * and install-docker.ps1's variables and functions, loaded in Windows
 * PowerShell without its last line (Start-Installation). Neither installs
 * anything.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GIT_BASH, psQuote } from './powershell.js';
import { createTempDir } from './test-env.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASH = process.platform === 'win32' ? GIT_BASH : 'bash';

/**
 * Runs `run(dir)` with a copy of `text` saved as `installer` in a temporary
 * folder `dir`, each key of `replace` replaced by its value (each key must be
 * in the text). Returns what `run` returns.
 */
function withCopy(installer, text, replace, run) {
  for (const [from, to] of Object.entries(replace)) {
    if (!text.includes(from)) throw new Error(`${installer} has no "${from}" to replace`);
    text = text.replaceAll(from, to);
  }
  const dir = createTempDir('dc-test-installer-');
  try {
    fs.writeFileSync(path.join(dir, installer), text);
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs `commands` in bash after sourcing install-docker.sh up to its main part, with `replace`; returns spawnSync's result */
export function runInstallerSh(commands, { replace = {} } = {}) {
  const text = fs.readFileSync(path.join(PROJECT_ROOT, 'install-docker.sh'), 'utf8');
  const main = text.indexOf('# Main execution logic');
  if (main < 0) throw new Error('install-docker.sh has no "# Main execution logic" line to stop before');
  return withCopy('install-docker.sh', text.slice(0, main), replace, (dir) =>
    spawnSync(BASH, ['-c', `source ./install-docker.sh && ${commands}`], { cwd: dir, encoding: 'utf8' }));
}

/**
 * Runs `commands` in Windows PowerShell, with `env`, after loading
 * install-docker.ps1's variables and functions, with `replace`; returns
 * spawnSync's result.
 */
export function runInstallerPs1(commands, { replace = {}, env = process.env } = {}) {
  const text = fs.readFileSync(path.join(PROJECT_ROOT, 'install-docker.ps1'), 'utf8');
  return withCopy('install-docker.ps1', text, replace, (dir) => {
    const script = [
      '$VerboseOutput = $false',
      `$ast = [System.Management.Automation.Language.Parser]::ParseFile(${psQuote(path.join(dir, 'install-docker.ps1'))}, [ref]$null, [ref]$null)`,
      'foreach ($statement in $ast.EndBlock.Statements) {',
      '  if ($statement -is [System.Management.Automation.Language.FunctionDefinitionAst] -or $statement -is [System.Management.Automation.Language.AssignmentStatementAst]) {',
      '    . ([ScriptBlock]::Create($statement.Extent.Text))',
      '  }',
      '}',
      commands,
    ].join('\n');
    return spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { env, encoding: 'utf8' });
  });
}
