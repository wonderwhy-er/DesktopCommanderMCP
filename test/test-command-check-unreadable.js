/**
 * A bash command the check can't read is refused: the check can't tell which
 * programs it runs, so it doesn't let it run. Bash refuses these commands
 * too, so nothing a user wanted is lost. The parse error may be anywhere in
 * the command: at the top, or only inside a $( ) or backticks.
 *
 * None of these commands names a blocked program, so a refusal here can
 * only come from the check failing to read the command. A well-formed
 * command next to them is allowed.
 *
 * A PowerShell command PowerShell can't parse is not refused by the check:
 * PowerShell then runs none of it and answers with its own parse error, which
 * tells the AI what to fix. `npm test && git push` is such a command in
 * Windows PowerShell 5.1, where && doesn't exist.
 *
 * A PowerShell that isn't there can't read the command, and isn't refused
 * by the check either: nothing can run, and start_process answers that the
 * shell wasn't found.
 *
 * Parse-only: nothing is run.
 */
import assert from 'assert';
import os from 'os';
import path from 'path';
import { configManager } from '../dist/config-manager.js';
import { commandManager } from '../dist/command-manager.js';
import { runIfMain, skip } from './helpers/run-if-main.js';
import { isTestHome } from './helpers/test-env.js';
import { installedPowerShells } from './helpers/powershell.js';

const UNREADABLE = [
  ['a quote that never closes', 'echo "unterminated'],
  ['an if with no fi, only inside $( )', 'echo "$(if true; then echo hi)"'],
  ['an if with no then, only inside backticks', 'echo `if true`'],
];

export default async function runTests() {
  // Sets blockedCommands, so only in a fresh test home.
  if (!isTestHome()) {
    skip('test-command-check-unreadable.js sets blockedCommands; run it through the runner: node test/run-all-tests.js test-command-check-unreadable.js');
    return true;
  }
  await configManager.setValue('blockedCommands', ['sudo']);

  const wrong = [];
  for (const [what, command] of UNREADABLE) {
    // Refused because the check failed to read it, with the parser's message as the reason
    const check = await commandManager.checkCommand(command, 'bash');
    if (check.verdict !== 'failed' || !check.reason) wrong.push(`${what} (${JSON.stringify(command)}) was ${JSON.stringify(check)}`);
    else console.log(`✓ refused, the check failed: ${what} (${check.reason})`);
  }
  const control = 'echo "$(if true; then echo hi; fi)"';
  assert.strictEqual(await commandManager.validateCommand(control, 'bash'), true, `a well-formed command is allowed: ${control}`);
  console.log('✓ allowed: the same command, well-formed');

  assert.deepStrictEqual(wrong, [], 'every command the check can\'t read is refused');

  const missing = path.join(os.tmpdir(), 'dc-no-such-folder', process.platform === 'win32' ? 'pwsh.exe' : 'pwsh');
  const notThere = await commandManager.checkCommand('echo hi', missing);
  assert.strictEqual(notThere.verdict, 'allowed', `a PowerShell that isn't there (${missing}) runs nothing, so the check doesn't refuse: ${JSON.stringify(notThere)}`);
  console.log('✓ not refused by the check: a PowerShell that isn\'t there');

  if (!installedPowerShells().includes('powershell')) {
    return skip('a Windows PowerShell 5.1 parse error goes through to PowerShell: Windows PowerShell is not installed here');
  }
  const ampersands = 'npm test && git push';
  assert.strictEqual(await commandManager.validateCommand(ampersands, 'powershell'), true,
    `Windows PowerShell's own parse error answers ${JSON.stringify(ampersands)}, not the check`);
  console.log('✓ not refused by the check: npm test && git push in Windows PowerShell 5.1');
  return true;
}

runIfMain(import.meta.url, runTests);
