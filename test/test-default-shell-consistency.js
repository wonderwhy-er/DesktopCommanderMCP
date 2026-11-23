/**
 * With no shell configured, start_process must run commands in the shell
 * Desktop Commander tells the AI about (system info) and gives a new config.
 * These used to be decided in separate places: on Windows system info and a
 * new config said powershell.exe while start_process ran cmd.exe (%ComSpec%).
 * The command check reads the command with the shell start_process runs, with
 * no shell configured and with defaultShell set.
 */

import assert from 'assert';
import path from 'path';
import { configManager } from '../dist/config-manager.js';
import { commandManager } from '../dist/command-manager.js';
import { startProcess } from '../dist/tools/improved-process-tools.js';
import { getSystemInfo } from '../dist/utils/system-info.js';
import { runIfMain, skip } from './helpers/run-if-main.js';
import { isTestHome } from './helpers/test-env.js';

// "C:\Windows\system32\cmd.exe", "cmd.exe" and "cmd" are the same shell
const shellName = (shell) => path.basename(String(shell)).toLowerCase().replace(/\.exe$/, '');

export default async function runTests() {
  // This test needs a new config and clears defaultShell, so never in a real home
  if (!isTestHome()) {
    skip('test-default-shell-consistency.js clears defaultShell; run it through the runner: node test/run-all-tests.js test-default-shell-consistency.js');
    return true;
  }

  const newConfigShell = (await configManager.getConfig()).defaultShell;
  const systemInfoShell = getSystemInfo().defaultShell;

  // The shells the command check reads commands with
  const checkedWith = [];
  const realCheck = commandManager.checkCommand;
  commandManager.checkCommand = (command, shell) => {
    checkedWith.push(shell);
    return realCheck.call(commandManager, command, shell);
  };

  await configManager.setValue('defaultShell', null);
  const result = await startProcess({ command: 'echo shell-check', timeout_ms: 5000 });
  const ranShell = result.structuredContent?.shell;

  console.log(`new config: ${newConfigShell} · system info: ${systemInfoShell} · start_process ran: ${ranShell}`);
  assert.strictEqual(shellName(ranShell), shellName(systemInfoShell),
    `with no shell configured, start_process ran ${ranShell} while system info tells the AI the default shell is ${systemInfoShell}`);
  assert.strictEqual(shellName(newConfigShell), shellName(systemInfoShell),
    `a new config gets ${newConfigShell} while system info says ${systemInfoShell}`);
  console.log('✓ start_process, system info and a new config name the same default shell');

  // Another shell than the default, so the check can't pass by reading with the default
  const otherShell = process.platform === 'win32' ? 'cmd' : ranShell === '/bin/sh' ? '/bin/bash' : '/bin/sh';
  await configManager.setValue('defaultShell', otherShell);
  const configured = await startProcess({ command: 'echo shell-check', timeout_ms: 5000 });
  commandManager.checkCommand = realCheck;
  assert.strictEqual(configured.structuredContent?.shell, otherShell, `with defaultShell ${otherShell}, start_process ran ${configured.structuredContent?.shell}`);
  assert.deepStrictEqual(checkedWith, [ranShell, otherShell],
    `the command check read the commands with ${JSON.stringify(checkedWith)}, while start_process ran ${ranShell}, then ${otherShell}`);
  console.log('✓ the command check reads each command with the shell start_process runs');
  return true;
}

runIfMain(import.meta.url, runTests);
