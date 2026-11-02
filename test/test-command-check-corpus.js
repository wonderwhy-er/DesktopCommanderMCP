/**
 * The command-check corpus as one test: one case per command, with the answer
 * the check SHOULD give in that command's shell — allow, refuse the blocked
 * program that really runs, or allow and say it can't see the program.
 * The cases, and the groups they are in, are listed in fixtures/command-check-corpus.mjs.
 *
 * Each command is checked with the shell it is written for. A PowerShell
 * command is checked with every PowerShell installed here (Windows PowerShell
 * and PowerShell 7), and skipped where neither is; a case's `expectPerShell`
 * gives the answer for one of them where the two differ. The other readers
 * need no shell installed.
 *
 * Nothing is run: every command goes to commandManager.checkCommand, which only parses it.
 */
import assert from 'assert';
import { commandManager } from '../dist/command-manager.js';
import { runIfMain, skip } from './helpers/run-if-main.js';
import { isTestHome } from './helpers/test-env.js';
import { installedPowerShells } from './helpers/powershell.js';
import { CORPUS } from './fixtures/command-check-corpus.mjs';

export default async function runTests() {
  // The answers hold for the default blockedCommands, which a fresh test home has
  if (!isTestHome()) {
    skip('test-command-check-corpus.js needs the default blockedCommands; run it through the runner: node test/run-all-tests.js test-command-check-corpus.js');
    return true;
  }

  const powershells = installedPowerShells();
  if (powershells.length < 2) {
    skip(`PowerShell cases are checked with the PowerShells installed here: ${powershells.join(' and ') || 'none'}`);
  }

  const failures = [];
  let checked = 0;
  for (const c of CORPUS) {
    const shells = c.shell === 'powershell' ? powershells : [c.shell];
    for (const shell of shells) {
      checked++;
      const expect = c.expectPerShell && Object.hasOwn(c.expectPerShell, shell) ? c.expectPerShell[shell] : c.expect;
      let check;
      try {
        check = await commandManager.checkCommand(c.command, shell);
      } catch (error) {
        failures.push(`${c.id} [${shell}]: checkCommand threw ${error && error.message}`);
        continue;
      }
      // unknowable: the check can't see the program, so it allows the command and says so (unseen).
      // A refused command must be blocked for the program that runs, not refused for another reason.
      let right, want;
      if (expect === null) {
        want = 'allowed';
        right = check.verdict === 'allowed';
      } else if (expect === 'unknowable') {
        want = 'unseen';
        right = check.verdict === 'unseen';
      } else {
        want = `blocked for ${expect}`;
        right = check.verdict === 'blocked' && check.name === expect;
      }
      if (!right) failures.push(`${c.id} [${c.group}/${shell}] should be ${want} but was ${JSON.stringify(check)}`);
    }
  }

  if (failures.length > 0) {
    console.log(`\n${failures.length} of ${checked} checks wrong:`);
    for (const f of failures) console.log(`  ✗ ${f}`);
  } else {
    console.log(`\nAll ${checked} checks right`);
  }
  assert.deepStrictEqual(failures, [], `${failures.length} of ${checked} command-check corpus checks are wrong`);
  return true;
}

runIfMain(import.meta.url, runTests);
