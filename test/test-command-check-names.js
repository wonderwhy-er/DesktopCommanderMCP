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
import { spawnSync } from 'child_process';
import { configManager } from '../dist/config-manager.js';
import { commandManager } from '../dist/command-manager.js';
import { programName } from '../dist/utils/shell.js';
import { installedPowerShells } from './helpers/powershell.js';
import { runIfMain, skip, SKIPPED } from './helpers/run-if-main.js';
import { isTestHome, withEnv } from './helpers/test-env.js';

const isWindows = process.platform === 'win32';
// Off Windows the rows below expect Linux's reading. A run started in WSL has WSL_DISTRO_NAME, so they clear it (the runner leaves it out itself)
const outsideWsl = { WSL_DISTRO_NAME: undefined };
// Windows' default PATHEXT, so the .com rows don't depend on this machine's (one without .COM keeps format.com)
const defaultPathExt = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC';

/**
 * A module that makes WSL's interop entry in binfmt_misc, which lets Linux run
 * Windows programs, there or not, whatever this machine has: it replaces
 * fs.existsSync for that entry.
 */
const interopEntry = (present) => `data:text/javascript,${encodeURIComponent(`
  import fs from 'fs';
  import { syncBuiltinESMExports } from 'module';
  const existsSync = fs.existsSync;
  fs.existsSync = (file) => String(file).startsWith('/proc/sys/fs/binfmt_misc/WSLInterop') ? ${present} : existsSync(file);
  syncBuiltinESMExports();`)}`;
// programName() reads the system once per process. This one reads it as without the entry, so the rows below expect Linux's reading on a WSL test machine too
await import(interopEntry(false));

/** Each row: a name, and the form programName() gives */
function expectNames(rows) {
  for (const [name, expected] of rows) {
    assert.strictEqual(programName(name), expected, `name ${name}`);
  }
}

async function thePathIsRemoved() {
  await withEnv(outsideWsl, () => expectNames([
    ['/usr/bin/sudo', 'sudo'],
    ['C:\\Windows\\System32\\net.exe', isWindows ? 'net' : 'net.exe'],
    ['C:/Windows/System32/net.exe', isWindows ? 'net' : 'net.exe'],
    ['\\Windows\\System32\\net', 'net'],
    ['Microsoft.PowerShell.Management\\Set-Content', 'set-content'],
    // A drive-relative path: sc.exe in the current folder of drive C:
    ['C:sc.exe', isWindows ? 'sc' : 'sc.exe'],
  ]));
}

async function theNameIsLowercased() {
  await withEnv(outsideWsl, () => expectNames([
    ['SUDO', 'sudo'],
    ['C:\\Windows\\System32\\SC.EXE', isWindows ? 'sc' : 'sc.exe'],
    ['Set-Content', 'set-content'],
  ]));
}

async function anExtensionIsDropped() {
  await withEnv({ ...outsideWsl, PATHEXT: defaultPathExt }, () => expectNames([
    ['sc.exe', isWindows ? 'sc' : 'sc.exe'],
    ['format.com', isWindows ? 'format' : 'format.com'],
    // Only one extension, and only one from PATHEXT
    ['sc.exe.exe', isWindows ? 'sc.exe' : 'sc.exe.exe'],
    ['deploy.ps1', 'deploy'],
  ]));
  // The list is the one commands run with: a PATHEXT broken to ".CPL" is repaired first (#481). Elsewhere PATHEXT isn't read
  await withEnv({ ...outsideWsl, PATHEXT: '.CPL' }, () => expectNames([
    ['sc.exe', isWindows ? 'sc' : 'sc.exe'],
    ['format.com', isWindows ? 'format' : 'format.com'],
    ['tool.cpl', isWindows ? 'tool' : 'tool.cpl'],
  ]));
}

/**
 * WSL runs Windows programs from Linux by their full name (sc.exe stop
 * Spooler), so there a name is read as on Windows. WSL sets WSL_DISTRO_NAME
 * for what it starts; the other checks run without it.
 */
async function inWslANameIsReadAsOnWindows() {
  await withEnv({ WSL_DISTRO_NAME: 'Ubuntu', PATHEXT: defaultPathExt }, () => expectNames([
    ['sc.exe', 'sc'],
    ['/mnt/c/Windows/System32/SC.EXE', 'sc'],
    ['format.com', 'format'],
    ['deploy.ps1', 'deploy'],
  ]));
}

/** The names programName() gives in another node, started without WSL_DISTRO_NAME and with the interop entry there or not */
function namesInAnotherNode(withInteropEntry, names) {
  const { WSL_DISTRO_NAME, ...env } = process.env;
  const shell = new URL('../dist/utils/shell.js', import.meta.url).href;
  const code = `import { programName } from ${JSON.stringify(shell)}; console.log(JSON.stringify(${JSON.stringify(names)}.map((name) => programName(name))));`;
  const child = spawnSync(process.execPath, ['--import', interopEntry(withInteropEntry), '--input-type=module', '--eval', code], {
    env: { ...env, PATHEXT: defaultPathExt }, encoding: 'utf8',
  });
  assert.strictEqual(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

/**
 * What WSL starts without WSL_DISTRO_NAME (a command through sudo, which
 * clears the environment, or a service) is known as WSL by the interop entry.
 * A Docker container on WSL's kernel has no such entry and can't run Windows
 * programs, so there a name keeps Linux's reading.
 */
function wslIsKnownByItsInteropEntryToo() {
  const names = ['sc.exe', '/mnt/c/Windows/System32/SC.EXE', 'format.com'];
  assert.deepStrictEqual(namesInAnotherNode(true, names), ['sc', 'sc', 'format'], 'with the interop entry');
  assert.deepStrictEqual(namesInAnotherNode(false, names), isWindows ? ['sc', 'sc', 'format'] : ['sc.exe', 'sc.exe', 'format.com'], 'without it');
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
  for (const check of [thePathIsRemoved, theNameIsLowercased, anExtensionIsDropped, inWslANameIsReadAsOnWindows, wslIsKnownByItsInteropEntryToo, anEntryIsComparedInTheSameForm]) {
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
