/**
 * The command-check corpus as one red test: one case per command, with the
 * answer the check SHOULD give — allow, or refuse the blocked program that
 * really runs in that command's shell. Built for the command-check research
 * (cards/RESEARCH-COMMAND-CHECK.md) from the 11 support cases, the GitHub
 * issues (#731 #795 #799 #822 #834 #870 #873 #890 #421 #423), the known
 * bypasses, wrappers, inline shells, run-time commands, a script file, and a
 * 14,000-character command.
 *
 * It fails on main today for two opposite reasons, both in the research:
 *   - safe commands are refused because a blocked word is only text inside a
 *     script, string, heredoc, here-string or table (cases 01–11, the issues);
 *   - blocked programs run because the check doesn't see them: { sudo ls; },
 *     "sudo" id, sudo on a second line, if sudo true, sc.exe, and every
 *     wrapper (env/nohup/timeout/…) and inline shell (bash -c, cmd /c, …).
 *
 * The four run-time/script-file cases (eval "$CMD", Invoke-Expression,
 * & $tool, bash deploy.sh) name no program in the text, so the check cannot
 * see one; the corpus marks them `unknowable` and expects them allowed, which
 * is what today does — they are not part of the red.
 *
 * Parse-only: every command goes to commandManager.validateCommand, never to a
 * shell or a process.
 */
import assert from 'assert';
import { configManager } from '../dist/config-manager.js';
import { commandManager } from '../dist/command-manager.js';
import { runIfMain, skip } from './helpers/run-if-main.js';
import { isTestHome } from './helpers/test-env.js';
import { CORPUS, BLOCKLIST_DEFAULT } from './fixtures/command-check-corpus.mjs';

export default async function runTests() {
  // Replaces blockedCommands with the default 33, so only in a fresh test home.
  if (!isTestHome()) {
    skip('test-command-check-corpus.js sets blockedCommands; run it through the runner: node test/run-all-tests.js test-command-check-corpus.js');
    return true;
  }
  await configManager.setValue('blockedCommands', BLOCKLIST_DEFAULT);

  const failures = [];
  for (const c of CORPUS) {
    // unknowable: the program can't be known from the text; the check must allow.
    const shouldAllow = c.expect === null || c.expect === 'unknowable';
    let allowed;
    try {
      allowed = await commandManager.validateCommand(c.command);
    } catch (error) {
      failures.push(`${c.id}: validateCommand threw ${error && error.message}`);
      continue;
    }
    if (allowed !== shouldAllow) {
      const names = JSON.stringify(commandManager.extractCommands(c.command));
      const want = shouldAllow ? 'allowed' : `refused (${c.expect} runs in ${c.shell})`;
      const got = allowed ? 'allowed' : 'refused';
      failures.push(`${c.id} [${c.group}/${c.shell}] should be ${want} but was ${got}; extracted ${names}`);
    }
  }

  if (failures.length > 0) {
    console.log(`\n${failures.length} of ${CORPUS.length} corpus cases wrong:`);
    for (const f of failures) console.log(`  ✗ ${f}`);
  } else {
    console.log(`\nAll ${CORPUS.length} corpus cases correct`);
  }
  assert.deepStrictEqual(failures, [], `${failures.length} of ${CORPUS.length} command-check corpus cases are wrong`);
  return true;
}

runIfMain(import.meta.url, runTests);
