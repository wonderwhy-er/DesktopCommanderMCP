/**
 * A command whose wrappers start one another many levels deep is checked
 * quickly: each program a wrapper starts is followed once, however many
 * readings lead to it. find runs each -exec's command up to the end of its
 * words, so in find . -exec find . -exec … echo every level finds the levels
 * after it again, and the work doubled with each level: 20 levels took 11 s
 * on Windows and 2 s on Linux, and the server answered nothing meanwhile.
 * These cases have 22; each must be answered within 2 s.
 *
 * The same goes for command texts: a word known only at run time after pwsh
 * may be -Command, so the rest of the words are a text for pwsh, and in
 * pwsh $a pwsh $a … each text gives every later one again. Each text is
 * checked once per command: 14 pairs, within 5 s (each text is looked up
 * and read by the PowerShell helper; the work doubling took 30 s). Where pwsh isn't
 * installed its texts can't be read, so that command is refused at once.
 *
 * Nothing is run: every command goes to commandManager.checkCommand, which only parses it.
 */
import assert from 'assert';
import { configManager } from '../dist/config-manager.js';
import { commandManager } from '../dist/command-manager.js';
import { runIfMain, skip } from './helpers/run-if-main.js';
import { isTestHome } from './helpers/test-env.js';
import { installedPowerShells } from './helpers/powershell.js';

const LIMIT_MS = 2000;

// Each command, its shell, the verdict (and blocked name) it must get, and how long it may take
const CASES = [
  ['bash', 'find . -exec '.repeat(22) + 'echo', { verdict: 'allowed' }],
  ['bash', 'find . -exec '.repeat(22) + 'sudo ls', { verdict: 'blocked', name: 'sudo' }],
  ['bash', Array(14).fill('pwsh $a').join(' '), { verdict: installedPowerShells().includes('pwsh') ? 'unseen' : 'failed' }, 5000],
];

export default async function runTests() {
  // It sets blockedCommands, so only in a fresh test home
  if (!isTestHome()) {
    skip('test-command-check-nesting.js sets blockedCommands; run it through the runner: node test/run-all-tests.js test-command-check-nesting.js');
    return true;
  }
  await configManager.setValue('blockedCommands', ['sudo']);
  // The PowerShell helper starts at the first PowerShell check (about a second on Windows); start it before the timing
  await commandManager.checkCommand("pwsh -Command 'Get-Date'", 'bash');

  const failures = [];
  for (const [shell, command, expected, limitMs = LIMIT_MS] of CASES) {
    const started = Date.now();
    const answer = await commandManager.checkCommand(command, shell);
    const took = Date.now() - started;
    const right = answer.verdict === expected.verdict && answer.name === expected.name && took <= limitMs;
    const shown = command.length > 60 ? `${command.slice(0, 40)}… (${command.split(' ').length} words)` : command;
    const got = JSON.stringify(answer).slice(0, 120);
    console.log(`${right ? '✓' : '✗'} ${shell}: ${shown} → ${got} in ${took} ms`);
    if (!right) failures.push(`${shown} should be ${JSON.stringify(expected)} within ${limitMs} ms, but was ${got} after ${took} ms`);
  }
  assert.deepStrictEqual(failures, [], `${failures.length} nested commands are checked wrong or too slowly`);
  return true;
}

runIfMain(import.meta.url, runTests);
