/**
 * With no shell configured, start_process must run commands in the shell
 * Desktop Commander tells the AI about (system info) and gives a new config.
 * These used to be decided in separate places: on Windows system info and a
 * new config said powershell.exe while start_process ran cmd.exe (%ComSpec%).
 */

import assert from 'assert';
import path from 'path';
import { configManager } from '../dist/config-manager.js';
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

  await configManager.setValue('defaultShell', null);
  const result = await startProcess({ command: 'echo shell-check', timeout_ms: 5000 });
  const ranShell = result.structuredContent?.shell;

  console.log(`new config: ${newConfigShell} · system info: ${systemInfoShell} · start_process ran: ${ranShell}`);
  assert.strictEqual(shellName(ranShell), shellName(systemInfoShell),
    `with no shell configured, start_process ran ${ranShell} while system info tells the AI the default shell is ${systemInfoShell}`);
  assert.strictEqual(shellName(newConfigShell), shellName(systemInfoShell),
    `a new config gets ${newConfigShell} while system info says ${systemInfoShell}`);
  console.log('✓ start_process, system info and a new config name the same default shell');
  return true;
}

runIfMain(import.meta.url, runTests);
