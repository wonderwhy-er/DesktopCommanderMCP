/**
 * The PowerShell tests, test/*.test.ps1 (remote-launcher-windows.test.ps1, the
 * Windows launcher's, among them), each with the first PowerShell here: Windows
 * PowerShell on Windows, pwsh elsewhere. A new *.test.ps1 runs without being
 * added anywhere. With no PowerShell here, the check is skipped and says so.
 */
import assert from 'assert';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { installedPowerShells } from './helpers/powershell.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default async function run() {
  const tests = fs.readdirSync(__dirname).filter((file) => file.endsWith('.test.ps1')).sort();
  assert.ok(tests.length > 0, 'the PowerShell tests, found by name');
  const [shell] = installedPowerShells();
  if (!shell) {
    skip(`no PowerShell here (${process.platform === 'win32' ? 'powershell or pwsh' : 'pwsh'}): ${tests.join(', ')} not run`);
    return;
  }
  // Windows PowerShell started under PowerShell 7 (GitHub's Windows steps run in pwsh) inherits
  // 7's PSModulePath, where it can't load its own modules (Get-FileHash); without one, it builds its own
  const env = shell === 'powershell'
    ? Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PSMODULEPATH'))
    : process.env;
  for (const test of tests) {
    // Bypass for this process only: Windows' default execution policy refuses a script file
    const policy = process.platform === 'win32' ? ['-ExecutionPolicy', 'Bypass'] : [];
    const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', ...policy, '-File', path.join(__dirname, test)],
      { cwd: path.dirname(__dirname), env, encoding: 'utf8', timeout: 300_000, windowsHide: true });
    const output = `${result.stdout}${result.stderr}`;
    assert.strictEqual(result.status, 0, `${test} with ${shell}: exit ${result.status}${result.error ? ` (${result.error.message})` : ''}\n${output.slice(-3000)}`);
    console.log(`✓ ${test} with ${shell}: ${output.trim().split(/\r?\n/).at(-1)}`);
  }
}

runIfMain(import.meta.url, run);
