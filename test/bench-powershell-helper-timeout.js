/**
 * Manual Windows diagnostic for issue #1061.
 *
 * Uses the production PowerShellHelper implementation to parse and inspect
 * synthetic commands. The submitted command texts are NEVER executed.
 *
 * Run after building:
 *   node test/bench-powershell-helper-timeout.js
 *   node test/bench-powershell-helper-timeout.js --require-repro
 *
 * Run outside CI: PowerShell startup, profiles, PATH and machine load affect
 * timing. --require-repro is useful for a machine exhibiting the issue.
 */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { PowerShellHelper, HELPER_TIMEOUT_MS } from '../dist/utils/powershell-commands.js';
import { installedPowerShells } from './helpers/powershell.js';

const shell = installedPowerShells()[0];
if (!shell) {
  console.log('SKIP: PowerShell is not installed');
  process.exit(0);
}

const commonNames = ['Get-ChildItem', 'Where-Object', 'Write-Output', 'Join-Path', 'Test-Path'];
const commands = [
  { name: '20 ordinary cmdlets', script: Array.from({ length: 20 }, (_, i) => `${commonNames[i % 5]} 'fixture'`).join('\n') },
  { name: '100 calls to 5 common cmdlets', script: Array.from({ length: 100 }, (_, i) => `${commonNames[i % 5]} 'fixture'`).join('\n') },
  { name: '100 calls to 5 missing names', script: Array.from({ length: 100 }, (_, i) => `DCTestNoSuchCommand_${i % 5}`).join('\n') },
  { name: '100 repeated known names', script: Array(100).fill("Write-Output 'fixture'").join('\n') },
  { name: '100 distinct missing names', script: Array.from({ length: 100 }, (_, i) => `DCTestNoSuchCommand_${String(i).padStart(4, '0')}`).join('\n') },
  ...[150, 300, 600, 1200].map((count) => ({
    name: `${count} distinct missing names`,
    script: Array.from({ length: count }, (_, i) => `DCTestNoSuchCommand_${String(i).padStart(4, '0')}`).join('\n'),
  })),
];

console.log(`PowerShell helper diagnostic; shell=${shell}; warm deadline=${HELPER_TIMEOUT_MS}ms`);
console.log('Input is inspected by PowerShellHelper, NEVER executed.');
const results = [];
for (const item of commands) {
  const helper = new PowerShellHelper(shell);
  try {
    // Warm the helper separately so startup's 15-second allowance does not
    // conceal failure under the normal 5-second warm-request deadline.
    const warm = await helper.read("Write-Output 'warmup'");
    assert.equal(warm.commands[0]?.nameAtRunTime, false);
    const started = performance.now();
    try {
      const result = await helper.read(item.script);
      const ms = Math.round(performance.now() - started);
      results.push({ case: item.name, ms, outcome: 'parsed', astCommands: result.commands.length });
    } catch (error) {
      const ms = Math.round(performance.now() - started);
      results.push({ case: item.name, ms, outcome: String(error?.message ?? error) });
    }
  } finally {
    helper.stop();
  }
}
console.table(results);
if (process.argv.includes('--require-repro')) {
  assert.ok(results.some((row) => row.outcome.includes('PowerShell did not answer in 5 seconds')),
    'None of the synthetic cases hit the five-second deadline; this is environment-dependent');
}
console.log('No requested command was executed; timeout still fails closed.');
