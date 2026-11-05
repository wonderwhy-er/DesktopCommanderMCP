// install-docker.ps1 names the folder of a 32-bit program, Program Files (x86), with its
// environment variable's real name.
//
// The variable is ProgramFiles(x86). PowerShell reads "$env:PROGRAMFILES(x86)\Claude" as the
// variable ProgramFiles followed by the text (x86), so the folder came out as
// C:\Program Files(x86)\Claude, which doesn't exist, and a Claude Desktop installed there was
// neither found by the installer's restart step nor stopped by it. The name needs braces:
// "${env:ProgramFiles(x86)}\Claude".
//
// The test loads install-docker.ps1's variables with ProgramFiles(x86) set, in every PowerShell
// on this machine (Windows PowerShell, PowerShell 7), and checks the list of folders Claude
// Desktop can be installed in, which Find-ClaudeProcess and Find-ClaudeExecutable look in. Then
// it checks that the installer writes no variable name with parentheses without braces.
//
// Run, on Windows, macOS or Linux, when a PowerShell is installed:
//   node test/docker-installer-claude-folders.test.js
// Exit code: 1 if a check fails; 3 when there is no PowerShell to run it in.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInstallerPs1 } from './helpers/docker-installers.js';
import { installedPowerShells } from './helpers/powershell.js';

const installer = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'install-docker.ps1'), 'utf8');
const x86 = 'C:\\Program Files (x86)';
let failed = false;

function check(name, ok, detail = '') {
  if (!ok) failed = true;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `: ${detail}` : ''}`);
}

const shells = installedPowerShells();
if (shells.length === 0) {
  console.log('⚠️  SKIPPED: no PowerShell (powershell, pwsh) on this machine');
  process.exit(3);
}

for (const shell of shells) {
  const run = runInstallerPs1('Write-Output ("FOLDERS " + (ConvertTo-Json -Compress -InputObject @($script:ClaudeDesktopFolders)))',
    { shell, env: { ...process.env, 'ProgramFiles(x86)': x86 } });
  const folders = JSON.parse(/^FOLDERS (.*)$/m.exec(run.stdout)?.[1] ?? 'null') ?? [];
  check(`${shell}: the folders Claude Desktop can be installed in include Program Files (x86)`,
    folders.includes(`${x86}\\Claude`), `got ${JSON.stringify(folders.filter((folder) => /x86/i.test(folder)))}${run.status === 0 ? '' : `, exit code ${run.status}: ${run.stderr.trim()}`}`);
}

const bare = installer.split('\n').map((line, index) => ({ line, number: index + 1 })).filter(({ line }) => /\$env:\w+\(/.test(line));
check('install-docker.ps1 writes no variable name with parentheses without braces', bare.length === 0,
  bare.map(({ number, line }) => `line ${number}: ${line.trim()}`).join('; '));

process.exitCode = failed ? 1 : 0;
