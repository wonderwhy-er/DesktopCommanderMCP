/**
 * programName() (dist/utils/shell.js): the command check compares the program
 * a command runs, and each blockedCommands entry, in the form programName()
 * gives, so a blocked program is refused however its name is written. This
 * file checks the form itself, and that an entry is put in it too.
 *
 * Nothing is run: names go to programName() and commands to checkCommand(),
 * which only parses them.
 */
import assert from 'assert';
import { configManager } from '../dist/config-manager.js';
import { commandManager } from '../dist/command-manager.js';
import { programName } from '../dist/utils/shell.js';
import { installedPowerShells } from './helpers/powershell.js';
import { runIfMain, skip, SKIPPED } from './helpers/run-if-main.js';
import { isTestHome, withEnv } from './helpers/test-env.js';

const isWindows = process.platform === 'win32';

/** Each row: a name, and the form programName() gives */
function expectNames(rows) {
  for (const [name, expected] of rows) {
    assert.strictEqual(programName(name), expected, `name ${name}`);
  }
}

async function thePathIsRemoved() {
  expectNames([
    ['/usr/bin/sudo', 'sudo'],
    ['C:\\Windows\\System32\\net.exe', isWindows ? 'net' : 'net.exe'],
    ['C:/Windows/System32/net.exe', isWindows ? 'net' : 'net.exe'],
    ['\\Windows\\System32\\net', 'net'],
    ['Microsoft.PowerShell.Management\\Set-Content', 'set-content'],
    // A drive-relative path: sc.exe in the current folder of drive C:
    ['C:sc.exe', isWindows ? 'sc' : 'sc.exe'],
  ]);
}

async function theNameIsLowercased() {
  expectNames([
    ['SUDO', 'sudo'],
    ['C:\\Windows\\System32\\SC.EXE', isWindows ? 'sc' : 'sc.exe'],
    ['Set-Content', 'set-content'],
  ]);
}

async function anExtensionIsDropped() {
  expectNames([
    ['sc.exe', isWindows ? 'sc' : 'sc.exe'],
    ['format.com', isWindows ? 'format' : 'format.com'],
    // Only one extension, and only one from PATHEXT
    ['sc.exe.exe', isWindows ? 'sc.exe' : 'sc.exe.exe'],
    ['deploy.ps1', 'deploy'],
  ]);
  // The list is the one commands run with: a PATHEXT broken to ".CPL" is repaired first (#481). Elsewhere PATHEXT isn't read
  await withEnv({ PATHEXT: '.CPL' }, () => expectNames([
    ['sc.exe', isWindows ? 'sc' : 'sc.exe'],
    ['format.com', isWindows ? 'format' : 'format.com'],
    ['tool.cpl', isWindows ? 'tool' : 'tool.cpl'],
  ]));
}

/**
 * WSL runs Windows programs from Linux by their full name (sc.exe stop
 * Spooler), so there a name is read as on Windows. WSL sets WSL_DISTRO_NAME
 * for what it starts; the runner leaves it out, so only this check has it.
 */
async function inWslANameIsReadAsOnWindows() {
  await withEnv({ WSL_DISTRO_NAME: 'Ubuntu' }, () => expectNames([
    ['sc.exe', 'sc'],
    ['/mnt/c/Windows/System32/SC.EXE', 'sc'],
    ['format.com', 'format'],
    ['deploy.ps1', 'deploy'],
  ]));
}

/**
 * An entry written with capitals, a path or .exe blocks its program, and the
 * answer names the entry as written. The PowerShell reader gives sc.exe as sc,
 * so an entry sc.exe matches only in this form.
 */
async function anEntryIsComparedInTheSameForm() {
  // Replaces blockedCommands, so only in a fresh test home
  if (!isTestHome()) return skip('anEntryIsComparedInTheSameForm sets blockedCommands; run it through the runner: node test/run-all-tests.js test-command-check-names.js');
  const powershells = installedPowerShells();
  if (powershells.length < 2) {
    skip(`The PowerShell entry check runs with the PowerShells installed here: ${powershells.join(' and ') || 'none'}`);
  }
  await configManager.setValue('blockedCommands', ['SC.EXE', '/usr/bin/sudo', 'C:\\Windows\\System32\\net.exe']);
  const rows = [
    ['bash', 'sc.exe stop Spooler', 'SC.EXE'],
    ['bash', 'sudo ls', '/usr/bin/sudo'],
    ...powershells.map((shell) => [shell, 'sc.exe stop Spooler', 'SC.EXE']),
  ];
  // Off Windows the entry keeps its .exe (net.exe), so a plain net doesn't match it there
  if (isWindows) rows.push(['cmd', 'net user', 'C:\\Windows\\System32\\net.exe']);
  for (const [shell, command, entry] of rows) {
    const check = await commandManager.checkCommand(command, shell);
    assert.deepStrictEqual([check.verdict, check.name], ['blocked', entry], `${command} in ${shell}: ${JSON.stringify(check)}`);
  }
}

export default async function runTests() {
  const failures = [];
  for (const check of [thePathIsRemoved, theNameIsLowercased, anExtensionIsDropped, inWslANameIsReadAsOnWindows, anEntryIsComparedInTheSameForm]) {
    try {
      console.log(`${await check() === SKIPPED ? '- skipped:' : '✓'} ${check.name}`);
    } catch (error) {
      failures.push(check.name);
      console.log(`✗ ${check.name}: ${error.message}`);
    }
  }
  return failures.length === 0;
}

runIfMain(import.meta.url, runTests);
