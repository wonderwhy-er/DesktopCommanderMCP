/**
 * The program sudo starts is checked like the programs other wrappers start
 * (the corpus has those). With the default blockedCommands every sudo
 * command is refused for sudo itself, so here the list blocks reboot only:
 * the program after sudo's options and NAME=VALUE settings must be refused,
 * and a word that is an option's value must not be taken for the program.
 *
 * Nothing is run: every command goes to commandManager.checkCommand, which only parses it.
 */
import assert from 'assert';
import { configManager } from '../dist/config-manager.js';
import { commandManager } from '../dist/command-manager.js';
import { runIfMain, skip } from './helpers/run-if-main.js';
import { isTestHome } from './helpers/test-env.js';

// Each command with the blocked program it runs, or null when it runs none
const CASES = [
  ['sudo reboot', 'reboot'],
  ['sudo -u root reboot', 'reboot'],
  ['sudo -iu root reboot', 'reboot'],
  ['sudo --user=root -E reboot', 'reboot'],
  ['sudo --user root -g wheel reboot', 'reboot'],
  ['sudo -- PATH=/sbin reboot', 'reboot'],
  ['sudo -u root env nohup reboot', 'reboot'],
  ['sudo -u reboot ls', null],
  ['sudo -C 3 -p reboot ls', null],
];

export default async function runTests() {
  // Sets blockedCommands, so only in a fresh test home
  if (!isTestHome()) {
    skip('test-command-check-sudo.js sets blockedCommands; run it through the runner: node test/run-all-tests.js test-command-check-sudo.js');
    return true;
  }
  await configManager.setValue('blockedCommands', ['reboot']);

  const failures = [];
  for (const [command, expect] of CASES) {
    const check = await commandManager.checkCommand(command, 'bash');
    const right = expect === null
      ? check.verdict === 'allowed'
      : check.verdict === 'blocked' && check.name === expect;
    if (!right) failures.push(`${command} should be ${expect === null ? 'allowed' : `blocked for ${expect}`} but was ${JSON.stringify(check)}`);
  }

  if (failures.length > 0) {
    console.log(`\n${failures.length} of ${CASES.length} checks wrong:`);
    for (const f of failures) console.log(`  ✗ ${f}`);
  } else {
    console.log(`\nAll ${CASES.length} checks right`);
  }
  assert.deepStrictEqual(failures, [], `${failures.length} of ${CASES.length} sudo checks are wrong`);
  return true;
}

runIfMain(import.meta.url, runTests);
