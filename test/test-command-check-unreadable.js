/**
 * A bash command the check can't read is refused: the check can't tell which
 * programs it runs, so it doesn't let it run. Bash refuses these commands
 * too, so nothing a user wanted is lost. The parse error may be anywhere in
 * the command: at the top, only inside a $( ) or backticks, or only in the
 * command text another shell is started with (bash -c, cmd /c). One is
 * refused although bash runs it: a command name whose braces make more than
 * 1000 words, more than the check expands.
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
 * shell wasn't found. A PowerShell named inside the command (C:\x\pwsh.exe
 * -Command …) is different: the shell that runs the command looks it up, in
 * its own working folder too. So in PowerShell the check reads its text with
 * the PowerShell running the command, and from another shell it refuses the
 * command, since it can't read the text. A PowerShell that is installed reads
 * the text given to it from bash too.
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

const missing = path.join(os.tmpdir(), 'dc-no-such-folder', process.platform === 'win32' ? 'pwsh.exe' : 'pwsh');

const UNREADABLE = [
  ['a quote that never closes', 'echo "unterminated'],
  ['an if with no fi, only inside $( )', 'echo "$(if true; then echo hi)"'],
  ['an if with no then, only inside backticks', 'echo `if true`'],
  ['a command name whose braces make more than 1000 words', 'x{1..1001}'],
  ['a quote that never closes, only inside bash -c', `bash -c 'echo "unterminated'`],
  // Git Bash passes //c to cmd as /c
  ['a ( group that is never closed, only inside cmd /c', 'cmd //c "(echo hi"'],
  ['a command given to a PowerShell that isn\'t here', `'${missing}' -Command 'echo hi'`],
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

  const notThere = await commandManager.checkCommand('echo hi', missing);
  assert.strictEqual(notThere.verdict, 'allowed', `a PowerShell that isn't there (${missing}) runs nothing, so the check doesn't refuse: ${JSON.stringify(notThere)}`);
  console.log('✓ not refused by the check: a PowerShell that isn\'t there');

  for (const shell of installedPowerShells()) {
    const namedInside = `& '${missing}' -Command 'sudo ls'`;
    const inside = await commandManager.checkCommand(namedInside, shell);
    assert.ok(inside.verdict === 'blocked' && inside.name === 'sudo',
      `in ${shell}, the text given to a PowerShell the check can't find is read by ${shell}: ${namedInside} was ${JSON.stringify(inside)}`);
    console.log(`✓ refused for sudo in ${shell}: the text given to a PowerShell that isn't here, read by ${shell}`);
    const fromBash = `${shell} -Command 'sudo ls'`;
    const read = await commandManager.checkCommand(fromBash, 'bash');
    assert.ok(read.verdict === 'blocked' && read.name === 'sudo', `from bash, ${shell} reads the text given to it: ${fromBash} was ${JSON.stringify(read)}`);
    console.log(`✓ refused for sudo in bash: the text given to ${shell}`);
  }

  if (!installedPowerShells().includes('powershell')) {
    return skip('a Windows PowerShell 5.1 parse error goes through to PowerShell: Windows PowerShell is not installed here');
  }
  const ampersands = 'npm test && git push';
  assert.strictEqual(await commandManager.validateCommand(ampersands, 'powershell'), true,
    `Windows PowerShell's own parse error answers ${JSON.stringify(ampersands)}, not the check`);
  console.log('✓ not refused by the check: npm test && git push in Windows PowerShell 5.1');
  const inner = `powershell -Command "${ampersands}"`;
  assert.strictEqual(await commandManager.validateCommand(inner, 'powershell'), true,
    `the inner Windows PowerShell's own parse error answers ${JSON.stringify(inner)}, not the check`);
  console.log('✓ not refused by the check: the same text given to powershell -Command');
  return true;
}

runIfMain(import.meta.url, runTests);
