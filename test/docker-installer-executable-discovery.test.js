// Search must reject an unrelated Claude.exe and continue to Claude Desktop.
// These fixtures never install or launch an executable.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { runInstallerPs1 } from './helpers/docker-installers.js';
import { installedPowerShells, psQuote } from './helpers/powershell.js';
import { createTempDir } from './helpers/test-env.js';

const shells = installedPowerShells();
if (!shells.length) process.exit(3);
const temp = createTempDir('dc-installer-discovery-');
let failed = false;
try {
  const programFiles = path.join(temp, 'Program Files');
  const unrelated = path.join(programFiles, 'A-UnrelatedVendor', 'Claude.exe');
  const desktop = path.join(programFiles, 'WindowsApps', 'Claude_9.9.9.0_x64__fixture', 'app', 'Claude.exe');
  mkdirSync(path.dirname(unrelated), { recursive: true });
  writeFileSync(unrelated, 'fixture only');
  for (const shell of shells) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !['programfiles', 'localappdata', 'programfiles(x86)'].includes(key.toLowerCase())));
    Object.assign(env, { ProgramFiles: programFiles, LOCALAPPDATA: path.join(temp, 'LocalData'), 'ProgramFiles(x86)': path.join(temp, 'x86') });
    // Windows aliases environment names by case; Unix PowerShell needs both spellings.
    const commands = `$env:ProgramFiles = ${psQuote(programFiles)};
      $env:PROGRAMFILES = ${psQuote(programFiles)};
      $env:LOCALAPPDATA = ${psQuote(env.LOCALAPPDATA)};
      \${env:ProgramFiles(x86)} = ${psQuote(env['ProgramFiles(x86)'])};
      $script:ClaudeDesktopFolders = @();
      function Get-ItemProperty { [CmdletBinding()] param($Path) @() };
      Write-Output ('FOUND ' + (Find-ClaudeExecutable))`;
    const missing = runInstallerPs1(commands, { shell, env });
    const found = /^FOUND (.*)$/m.exec(missing.stdout)?.[1]?.trim();
    const rejects = missing.status === 0 && found === '';
    console.log(`${rejects ? 'PASS' : 'FAIL'} ${shell}: unrelated executable rejected; found ${found}`);
    if (!rejects) failed = true;
    mkdirSync(path.dirname(desktop), { recursive: true });
    writeFileSync(desktop, 'fixture only');
    const positive = runInstallerPs1(commands, { shell, env });
    const selected = /^FOUND (.*)$/m.exec(positive.stdout)?.[1]?.trim();
    const accepts = positive.status === 0 && selected?.toLowerCase() === desktop.toLowerCase();
    console.log(`${accepts ? 'PASS' : 'FAIL'} ${shell}: Desktop selected after unrelated result; found ${selected}`);
    if (!accepts) failed = true;
    rmSync(desktop);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
