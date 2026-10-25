/**
 * start_process checks a command against blockedCommands the way the shell that
 * runs it reads it: the shell is chosen first, and it decides the grammar. Shells
 * without a grammar here (cmd, fish) keep the shell-agnostic scan. The grammars
 * have their own tests: test-posix-command-words.js, test-powershell-command-words.js.
 */
import assert from 'assert';
import path from 'path';
import { commandManager } from '../dist/command-manager.js';
import { configManager } from '../dist/config-manager.js';
import { startProcess } from '../dist/tools/improved-process-tools.js';
import { getDefaultShell, getShellSyntax } from '../dist/utils/shell.js';
import { runIfMain, skip } from './helpers/run-if-main.js';
import { isTestHome } from './helpers/test-env.js';

async function runTests() {
  let failures = 0;
  function check(name, actual, expected) {
    try {
      assert.deepStrictEqual(actual, expected);
      console.log(`✓ ${name}`);
    } catch {
      failures++;
      console.error(`✗ ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }

  console.log('The shell decides the grammar');
  const syntaxes = {
    posix: ['bash', '/bin/bash', path.join('Program Files', 'Git', 'bin', 'bash.exe'), 'zsh', '/bin/sh', 'dash', 'ksh'],
    'windows-powershell': ['powershell.exe', 'POWERSHELL.EXE', path.join('Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')],
    powershell: ['pwsh', 'pwsh.exe', path.join('Program Files', 'PowerShell', '7', 'pwsh.exe')],
    none: ['cmd.exe', 'fish', '/usr/bin/nu', 'wsl.exe'],
  };
  for (const [syntax, shells] of Object.entries(syntaxes)) {
    for (const shell of shells) check(`${shell} is read as ${syntax}`, getShellSyntax(shell) ?? 'none', syntax);
  }

  // The rest replaces blockedCommands, so never in a real home
  if (!isTestHome()) {
    skip('test-command-check-by-shell.js replaces blockedCommands; run it through the runner: node test/run-all-tests.js test-command-check-by-shell.js');
    return failures === 0;
  }

  console.log('\nvalidateCommand checks the names its shell runs');
  await configManager.setValue('blockedCommands', ['sudo', 'reg', 'format', 'shutdown', 'init']);
  const refused = async (command, shell) => !(await commandManager.validateCommand(command, shell));
  check('a heredoc that names a blocked command is allowed', await refused("python3 - <<'PY'\nREG = 'example'\nprint(REG)\nPY", 'bash'), false);
  check('a blocked command on the next line is refused', await refused('echo safe\nsudo whoami', 'bash'), true);
  check('a blocked command in a $(( subshell is refused', await refused('out=$((cd build && sudo make) 2>&1)', 'bash'), true);
  check('a here-string that names a blocked command is allowed', await refused("$t = @'\nformat\n'@", 'powershell.exe'), false);
  check('a blocked command assigned in PowerShell is refused', await refused('$x = shutdown /s', 'powershell.exe'), true);
  check('a blocked command after using is refused', await refused('using namespace System.IO; shutdown /r /t 0', 'pwsh'), true);
  check('a blocked name a variable calls as an argument is allowed', await refused('& $client init', 'powershell.exe'), false);
  check('pwsh decodes `u{73}: the blocked name it spells is refused', await refused('`u{73}hutdown /s', 'pwsh'), true);
  check('Windows PowerShell reads `u as u: the same line runs nothing blocked', await refused('`u{73}hutdown /s', 'powershell.exe'), false);
  // The names the issues allow as data are still refused when they run
  for (const shell of ['powershell.exe', 'pwsh']) {
    check(`${shell}: format c: is refused`, await refused('format c:', shell), true);
    check(`${shell}: init after another command is refused`, await refused('Write-Output x; init 0', shell), true);
  }
  check('cmd keeps the shell-agnostic scan', await refused('echo hi & format c:', 'cmd.exe'), true);
  const deep = '$('.repeat(20000) + 'sudo' + ')'.repeat(20000);
  check('a command nested too deep to read is refused', await refused(deep, 'bash'), true);

  // whoami is harmless if a broken check let it run
  console.log('\nstart_process checks a command with the shell it runs it in');
  const syntax = getShellSyntax(getDefaultShell());
  if (syntax === undefined) {
    skip(`the default shell ${getDefaultShell()} has no grammar here: start_process was not checked`);
  } else {
    await configManager.setValue('blockedCommands', ['whoami']);
    const blocked = await startProcess({ command: 'echo checked\nwhoami', timeout_ms: 5000 });
    check('a blocked command on the second line is refused', blocked.structuredContent?.blocked === true, true);
    const dataOnly = syntax === 'posix'
      ? "cat <<'EOF'\nprint(whoami)\nEOF"
      : "@{ Stage='a'; Operation='Device whoami then check' } | ConvertTo-Json";
    const ran = await startProcess({ command: dataOnly, timeout_ms: 5000 });
    check('a blocked name that is only data to the shell runs', ran.structuredContent?.blocked === true, false);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    return false;
  }
  console.log('\nAll checks passed');
  return true;
}

runIfMain(import.meta.url, runTests);
