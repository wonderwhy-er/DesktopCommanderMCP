/**
 * A command whose wrappers start one another many levels deep is checked
 * quickly: each program a wrapper starts is followed once, however many
 * readings lead to it. find runs each -exec's command up to the end of its
 * words, so in find . -exec find . -exec … echo every level finds the levels
 * after it again, and the work doubled with each level: 20 levels took 11 s
 * on Windows and 2 s on Linux, and the server answered nothing meanwhile.
 * These cases have 22; each must be answered within 2 s.
 *
 * Nothing is run: every command goes to commandManager.checkCommand, which only parses it.
 */
import assert from 'assert';
import { configManager } from '../dist/config-manager.js';
import { commandManager } from '../dist/command-manager.js';
import { runIfMain, skip } from './helpers/run-if-main.js';
import { isTestHome } from './helpers/test-env.js';

const LIMIT_MS = 2000;

// Each command, its shell and the answer it must get
const CASES = [
  ['bash', 'find . -exec '.repeat(22) + 'echo', { verdict: 'allowed' }],
  ['bash', 'find . -exec '.repeat(22) + 'sudo ls', { verdict: 'blocked', name: 'sudo' }],
];

export default async function runTests() {
  // It sets blockedCommands, so only in a fresh test home
  if (!isTestHome()) {
    skip('test-command-check-nesting.js sets blockedCommands; run it through the runner: node test/run-all-tests.js test-command-check-nesting.js');
    return true;
  }
  await configManager.setValue('blockedCommands', ['sudo']);

  const failures = [];
  for (const [shell, command, expected] of CASES) {
    const started = Date.now();
    const answer = await commandManager.checkCommand(command, shell);
    const took = Date.now() - started;
    const right = JSON.stringify(answer) === JSON.stringify(expected) && took <= LIMIT_MS;
    const shown = command.length > 60 ? `${command.slice(0, 40)}… (${command.split(' ').length} words)` : command;
    console.log(`${right ? '✓' : '✗'} ${shell}: ${shown} → ${JSON.stringify(answer)} in ${took} ms`);
    if (!right) failures.push(`${shown} should be ${JSON.stringify(expected)} within ${LIMIT_MS} ms, but was ${JSON.stringify(answer)} after ${took} ms`);
  }
  assert.deepStrictEqual(failures, [], `${failures.length} nested commands are checked wrong or too slowly`);
  return true;
}

runIfMain(import.meta.url, runTests);
