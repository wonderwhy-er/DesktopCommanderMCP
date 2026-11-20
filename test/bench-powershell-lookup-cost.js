/**
 * Manual PowerShell discovery-cost diagnostic for #1061. Does NOT execute
 * submitted commands, change the helper, or decide which commands are allowed.
 *
 *   node test/bench-powershell-lookup-cost.js
 */
import { spawnSync } from 'node:child_process';
import { installedPowerShells } from './helpers/powershell.js';

const shell = installedPowerShells()[0];
if (!shell) { console.log('SKIP: PowerShell unavailable'); process.exit(0); }
const ps = `
$PSModuleAutoLoadingPreference = 'None'
$ErrorActionPreference = 'Stop'
$cases = @(
  @{ name='20 common names'; names=@(1..20 | ForEach-Object { @('Get-ChildItem','Where-Object','Write-Output','Join-Path','Test-Path')[($_-1)%5] }) },
  @{ name='100 calls to 5 common names'; names=@(1..100 | ForEach-Object { @('Get-ChildItem','Where-Object','Write-Output','Join-Path','Test-Path')[($_-1)%5] }) },
  @{ name='100 calls to 5 nonexistent names'; names=@(1..100 | ForEach-Object { 'DCNoSuchCommand_'+(($_-1)%5) }) },
  @{ name='100 distinct nonexistent names'; names=@(1..100 | ForEach-Object { 'DCNoSuchCommand_'+$_ }) }
)
foreach($case in $cases) {
  $scriptText = $case.names -join [Environment]::NewLine
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $null = [Management.Automation.Language.Parser]::ParseInput($scriptText, [ref]$null, [ref]$null)
  $clock.Stop()
  $parseMs = $clock.ElapsedMilliseconds
  $clock.Restart()
  foreach($name in $case.names) {
    $null = @(Microsoft.PowerShell.Core\\Get-Command -Name ([Management.Automation.WildcardPattern]::Escape($name)) -ErrorAction SilentlyContinue)
  }
  $clock.Stop()
  $lookupMs = $clock.ElapsedMilliseconds
  $clock.Restart()
  $seen = @{}
  foreach($name in $case.names) {
    $key = $name.ToLowerInvariant()
    if (-not $seen.ContainsKey($key)) {
      $seen[$key] = @(Microsoft.PowerShell.Core\\Get-Command -Name ([Management.Automation.WildcardPattern]::Escape($name)) -ErrorAction SilentlyContinue)
    }
    $null = $seen[$key]
  }
  $clock.Stop()
  [pscustomobject]@{
    case=$case.name; occurrences=$case.names.Count; uniqueNames=$seen.Count;
    parseMs=$parseMs; lookupPerOccurrenceMs=$lookupMs; lookupMemoizedMs=$clock.ElapsedMilliseconds
  }
} 
`;
const out=spawnSync(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { encoding:'utf8', windowsHide:true, timeout:120_000, maxBuffer:1024*1024 });
if(out.error) throw out.error;
if(out.status!==0) throw new Error(out.stderr || `PowerShell diagnostic exited ${out.status}`);
console.log(out.stdout);
console.log('Memoized results are a performance comparison only, not a proposed safe replacement for production resolution.');
