// Installation folders are literal paths, even when a profile name contains brackets.
// Only the Store package-name segment intentionally uses a wildcard.
import { runInstallerPs1 } from './helpers/docker-installers.js';
import { installedPowerShells, psQuote } from './helpers/powershell.js';

const shells = installedPowerShells();
if (!shells.length) process.exit(3);
const cases = [
  { path: 'C:\\Users\\Jo[1]\\AppData\\Local\\Programs\\Claude\\Claude.exe', expected: true },
  { path: 'C:\\Users\\Jo1\\AppData\\Local\\Programs\\Claude\\Claude.exe', expected: false },
  { path: 'C:\\Users\\Jo[1]\\AppData\\Local\\AnthropicClaude\\app\\Claude.exe', expected: true },
  { path: 'C:\\Program Files [x]\\WindowsApps\\Claude_1.2_x64__fixture\\app\\Claude.exe', expected: true },
  { path: 'C:\\Plain\\Claude\\Claude.exe', expected: true },
  { path: 'C:\\Plain\\ClaudeOther\\Claude.exe', expected: false },
  { path: 'C:/Users/Jo[1]/AppData/Local/Programs/Claude/Claude.exe', expected: true },
  { path: 'C:/Program Files [x]/WindowsApps/Claude_1.2_x64__fixture/app/Claude.exe', expected: true },
  { path: 'C:/Users/Jo1/AppData/Local/Programs/Claude/Claude.exe', expected: false },
];
let failed = false;
for (const shell of shells) {
  const commands = `
$env:ProgramFiles = 'C:\\Program Files [x]'
$env:LOCALAPPDATA = 'C:\\Users\\Jo[1]\\AppData\\Local'
$script:ClaudeDesktopFolders = @('C:\\Users\\Jo[1]\\AppData\\Local\\Programs\\Claude', 'C:\\Plain\\Claude')
$failed = $false
foreach ($case in (${psQuote(JSON.stringify(cases))} | ConvertFrom-Json)) {
  $actual = Test-ClaudeDesktopExecutablePath $case.path
  if ($actual -ne $case.expected) {
    Write-Output ('FAIL ${shell}: ' + $case.path + '; expected ' + $case.expected + ', got ' + $actual)
    $failed = $true
  } else {
    Write-Output ('PASS ${shell}: ' + $case.path)
  }
}
if ($failed) { exit 1 }
`;
  const result = runInstallerPs1(commands, { shell });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.status !== 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
