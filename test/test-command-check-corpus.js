/**
 * The command-check corpus as one test: one case per command, with the answer
 * the check SHOULD give in that command's shell — allow, or refuse the blocked
 * program that really runs. The cases are the 11 support cases, the GitHub
 * issues (#731 #795 #799 #822 #834 #870 #873 #890 #421 #423), the known
 * bypasses, PowerShell @{ } tables, wrappers, inline shells, run-time
 * commands, a script file, a script's own functions, and a 14,000-character
 * command.
 *
 * Each case names the card whose change makes the check right for it. Only
 * the cards in CARDS_IN run; the others are skipped with their card named,
 * until that card's change turns them on.
 *
 * Each command is checked with the shell it is written for. A PowerShell
 * command is checked with every PowerShell installed here (Windows PowerShell
 * and PowerShell 7), and skipped where neither is. The other readers need no
 * shell installed. A case marked with an `os` runs only on that system.
 *
 * Parse-only: every command goes to commandManager.checkCommand, never to a
 * shell or a process.
 */
import assert from 'assert';
import { configManager } from '../dist/config-manager.js';
import { commandManager } from '../dist/command-manager.js';
import { isShellAvailable } from '../dist/utils/shell.js';
import { runIfMain, skip } from './helpers/run-if-main.js';
import { isTestHome } from './helpers/test-env.js';
import { CORPUS, BLOCKLIST_DEFAULT } from './fixtures/command-check-corpus.mjs';

/** The cards whose cases run: each change in the command-check stack adds its own */
const CARDS_IN = new Set(['B15', 'B19']);

/** The PowerShell programs a PowerShell case is checked with, where installed */
const POWERSHELLS = ['powershell', 'pwsh'];

export default async function runTests() {
  // Replaces blockedCommands with the default 33, so only in a fresh test home.
  if (!isTestHome()) {
    skip('test-command-check-corpus.js sets blockedCommands; run it through the runner: node test/run-all-tests.js test-command-check-corpus.js');
    return true;
  }
  await configManager.setValue('blockedCommands', BLOCKLIST_DEFAULT);

  const waiting = new Map();
  for (const c of CORPUS) {
    if (CARDS_IN.has(c.card)) continue;
    const card = c.card ?? 'no card in this round (wrappers and inline shells)';
    waiting.set(card, [...(waiting.get(card) ?? []), c.id]);
  }
  for (const [card, ids] of waiting) skip(`${ids.length} corpus cases wait for ${card}: ${ids.join(', ')}`);

  const powershells = POWERSHELLS.filter((shell) => isShellAvailable(shell));
  if (powershells.length < POWERSHELLS.length) {
    const missing = POWERSHELLS.filter((shell) => !powershells.includes(shell));
    skip(`PowerShell cases not checked with ${missing.join(' or ')}: not installed here`);
  }

  // A case whose answer holds on one system only (a Windows path to a program) is skipped elsewhere
  const otherSystem = CORPUS.filter((c) => CARDS_IN.has(c.card) && c.os && c.os !== process.platform);
  for (const c of otherSystem) skip(`${c.id} is checked on ${c.os} only, not on ${process.platform}`);

  const failures = [];
  let checked = 0;
  for (const c of CORPUS.filter((c) => CARDS_IN.has(c.card) && !otherSystem.includes(c))) {
    // unknowable: the program can't be known from the text; the check must allow.
    const shouldAllow = c.expect === null || c.expect === 'unknowable';
    const shells = c.shell === 'powershell' ? powershells : [c.shell];
    for (const shell of shells) {
      checked++;
      let check;
      try {
        check = await commandManager.checkCommand(c.command, shell);
      } catch (error) {
        failures.push(`${c.id} [${shell}]: checkCommand threw ${error && error.message}`);
        continue;
      }
      // An allowed command may be "unseen" (allowed, with a program the check can't see).
      // A refused one must be blocked for the program that runs, not refused for another reason.
      const right = shouldAllow
        ? check.verdict === 'allowed' || check.verdict === 'unseen'
        : check.verdict === 'blocked' && check.name === c.expect;
      if (!right) {
        const want = shouldAllow ? 'allowed' : `blocked for ${c.expect}`;
        failures.push(`${c.id} [${c.group}/${shell}] should be ${want} but was ${JSON.stringify(check)}`);
      }
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
