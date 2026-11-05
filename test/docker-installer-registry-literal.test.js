// Registry candidates and bracketed folders must identify real Desktop files.
// No executable is launched; registry rows and fallback isolation are test fixtures.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { runInstallerPs1 } from './helpers/docker-installers.js';
import { installedPowerShells, psQuote } from './helpers/powershell.js';
import { createTempDir } from './helpers/test-env.js';

const shells = installedPowerShells();
if (!shells.length) process.exit(3);
const temp = createTempDir('dc-registry-literal-');
let failed = false;
function fixture(profile) {
  const home = path.join(temp, profile);
  const programs = path.join(home, 'Program Files');
  const local = path.join(home, 'Local');
  const desktop = path.join(programs, 'WindowsApps', 'Claude_9.9_x64__fixture', 'app', 'Claude.exe');
  const unrelated = path.join(programs, 'UnrelatedVendor', 'Claude.exe');
  const classic = path.join(local, 'Programs', 'Claude', 'Claude.exe');
  for (const file of [desktop, unrelated, classic]) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'fixture only');
  }
  return { programs, local, home, desktop, unrelated, classic };
}
try {
  const plain = fixture('Plain');
  const bracketed = fixture('Jo[1]');
  const row = file => ({ DisplayName: 'Claude Desktop', InstallLocation: path.dirname(file) });
  const uninstall = file => ({ DisplayName: 'Claude Desktop',
    UninstallString: path.join(path.dirname(file), 'uninstall.exe') });
  const cases = [
    ['reject unrelated registry install', plain, [row(plain.unrelated)], [], false, ''],
    ['reject unrelated registry uninstall', plain, [uninstall(plain.unrelated)], [], false, ''],
    ['select Desktop after unrelated registry row', plain, [row(plain.unrelated), row(plain.desktop)],
      [], false, plain.desktop],
    ['accept bracketed classic file', bracketed, [], [path.dirname(bracketed.classic)], false, bracketed.classic],
    ['accept bracketed registry install', bracketed, [row(bracketed.desktop)], [], false, bracketed.desktop],
    ['accept bracketed registry uninstall', bracketed, [uninstall(bracketed.desktop)], [], false, bracketed.desktop],
    ['enumerate bracketed fallback root literally', bracketed, [], [], true, bracketed.desktop],
  ].map(([name, data, entries, folders, allowFallback, expected]) =>
    ({ name, data, entries, folders, allowFallback, expected }));
  for (const shell of shells) {
    const commands = `
      function Get-ItemProperty { [CmdletBinding()] param($Path) $script:FixtureRegistry }
      function Get-ChildItem {
        [CmdletBinding()] param($Path, $LiteralPath, [switch]$Recurse, $Filter, [switch]$File)
        if ($script:AllowFallback) { Microsoft.PowerShell.Management\\Get-ChildItem @PSBoundParameters }
      }
      $failed = $false
      foreach ($case in (${psQuote(JSON.stringify(cases))} | ConvertFrom-Json)) {
        $env:ProgramFiles = $case.data.programs
        $env:PROGRAMFILES = $case.data.programs
        $env:LOCALAPPDATA = $case.data.local
        $env:APPDATA = $case.data.home + '/Roaming'
        $env:USERPROFILE = $case.data.home
        \${env:ProgramFiles(x86)} = $case.data.home + '/x86'
        $script:ClaudeDesktopFolders = @($case.folders | Where-Object { $_ })
        $script:FixtureRegistry = @($case.entries)
        $script:AllowFallback = $case.allowFallback
        $found = Find-ClaudeExecutable
        $actual = ($found -replace '\\\\', '/').ToLowerInvariant()
        $expected = ($case.expected -replace '\\\\', '/').ToLowerInvariant()
        if ($actual -ne $expected) {
          Write-Output ('FAIL ${shell}: ' + $case.name + '; found ' + $found)
          $failed = $true
        } else { Write-Output ('PASS ${shell}: ' + $case.name) }
      }
      if ($failed) { exit 1 }
    `;
    const result = runInstallerPs1(commands, { shell });
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    if (result.status !== 0) failed = true;
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
