/**
 * What start_process answers after the check for blocked commands (#870, #873).
 *
 * A refused command got only "Error: Command not allowed: <the whole command>",
 * and the same text came when the check itself failed (for example on a bash
 * command it can't read). Neither the AI nor the user could tell which word
 * was blocked, or whether anything was blocked at all. A command whose program
 * is only known when it runs (eval "$CMD", Invoke-Expression $cmd, & $tool) or
 * is in a script file (bash deploy.sh) ran without a word that the blocklist
 * couldn't see that program.
 *
 * Checked here:
 * - through the real server: the refusal of `sudo ls` names sudo, the refusal
 *   of a bash command the check can't read gives the reason, and the corpus's
 *   four commands the blocklist can't see (rt_eval is eval "$CMD"; rt_iex,
 *   rt_amp_var, file_bash) each run, with a note at the end of the answer
 *   naming what hid the program;
 * - in this process: what checkCommand() answers unseen for, with the shells'
 *   options around a script file, and commands that hide nothing.
 * Only the parts this feature decides are checked here; the answers' exact
 * texts are in test-client-results.js.
 */
import assert from 'assert';
import { answerText, connectToServer, closeClient } from './helpers/mcp-client.js';
import { GIT_BASH, installedPowerShells } from './helpers/powershell.js';
import { runIfMain, skip } from './helpers/run-if-main.js';
import { isTestHome } from './helpers/test-env.js';
import { CORPUS } from './fixtures/command-check-corpus.mjs';
import { commandManager } from '../dist/command-manager.js';
import { isShellAvailable } from '../dist/utils/shell.js';

/** The corpus commands the blocklist can't see, with what the note at the end of each answer names */
const UNSEEN = { rt_eval: '(eval)', rt_iex: '(Invoke-Expression)', rt_amp_var: '($tool)', file_bash: 'deploy.sh' };

/** Each failed check, so one run shows all of them */
const failures = [];

/** Runs one check: a failure is recorded and printed, and the next check runs */
async function check(label, run) {
  try {
    await run();
    console.log(`✓ ${label}`);
  } catch (error) {
    failures.push(label);
    console.error(`✗ ${label}: ${error.message}`);
  }
}

async function callStartProcess(client, command, shell) {
  const result = await client.callTool({ name: 'start_process', arguments: { command, shell, timeout_ms: 15000 } });
  return { text: answerText(result), isError: result.isError === true };
}

/** Through the real server: the refusal names the blocked word or the reason, and commands the blocklist can't see run with a note */
async function testThroughServer(bash, powershells) {
  // A fresh home gets the default blockedCommands, which have sudo. CMD is left
  // out, so eval "$CMD" runs nothing.
  const { CMD, ...env } = process.env;
  const client = await connectToServer('test-command-check-answers', env);
  try {
    if (!bash) {
      skip('the bash commands (sudo ls, echo "unclosed, rt_eval, file_bash) need bash; on Windows Git Bash');
    } else {
      await check(`sudo ls is refused naming sudo (${bash})`, async () => {
        const refused = await callStartProcess(client, 'sudo ls', bash);
        assert(refused.isError, `sudo ls should be refused, got:\n${refused.text}`);
        assert(refused.text.includes('"sudo"'), `the refusal of sudo ls should name sudo, got:\n${refused.text}`);
      });
      await check(`a command the check can't read is refused, saying why (${bash})`, async () => {
        const failed = await callStartProcess(client, 'echo "unclosed', bash);
        assert(failed.isError, `echo "unclosed should be refused, got:\n${failed.text}`);
        assert(/\bfailed\b/.test(failed.text), `the refusal should say the check failed, got:\n${failed.text}`);
        assert(failed.text.includes('(unterminated double quote)'), `the refusal should give the reason, got:\n${failed.text}`);
      });
    }

    if (powershells.length === 0) {
      skip('the corpus\'s PowerShell commands (rt_iex, rt_amp_var) need PowerShell: none is installed');
    }
    for (const [id, what] of Object.entries(UNSEEN)) {
      const c = CORPUS.find((row) => row.id === id);
      assert(c?.expect === 'unknowable', `the corpus should have ${id} as a command the blocklist can't see`);
      const shells = c.shell === 'powershell' ? powershells : bash ? [bash] : [];
      for (const shell of shells) {
        await check(`${id} runs, with its note (${shell})`, async () => {
          const answer = await callStartProcess(client, c.command, shell);
          assert(!answer.isError && /^Process started with PID \d+/.test(answer.text),
            `${id} (${c.command}) should run, got:\n${answer.text}`);
          const lastLine = answer.text.trimEnd().split('\n').pop();
          assert(lastLine.includes(what), `${id}'s answer should end with a note naming ${what}, got:\n${answer.text}`);
        });
      }
    }
  } finally {
    await closeClient(client);
  }
}

/**
 * What hides a program from the check: the four kinds, the shells' options
 * around a script file or a command text, and commands that hide nothing, as
 * checkCommand() reads them.
 */
async function testUnseen(powershells) {
  const runTime = (what) => [{ what, inFile: false }];
  const inFile = (what) => [{ what, inFile: true }];
  // A Windows path to bash.exe names bash only on Windows, where the program's name drops .exe
  const isWindows = process.platform === 'win32';
  const cases = [
    ['bash', 'eval "$CMD"', runTime('eval')],
    ['powershell', 'iex $cmd', runTime('Invoke-Expression')],
    // A text eval or Invoke-Expression is given whole is read, so nothing is hidden; a text known only in part still is
    ['bash', "eval 'echo hi'", []],
    ['powershell', "iex 'Get-Date'", []],
    ['bash', 'eval "ls $X"', runTime('eval')],
    ['powershell', '& $tool stop Spooler', runTime('$tool')],
    ['bash', 'bash deploy.sh', inFile('deploy.sh')],
    ['bash', 'bash -o pipefail -x deploy.sh', inFile('deploy.sh')],
    ['bash', 'source ./env.sh', inFile('./env.sh')],
    ['bash', 'bash "$SCRIPT"', runTime('bash')],
    ['bash', '/usr/bin/bash deploy.sh', inFile('deploy.sh')],
    ['cmd', 'C:\\Git\\bin\\bash.exe deploy.sh', isWindows ? inFile('deploy.sh') : []],
    ['powershell', 'powershell -ExecutionPolicy Bypass -File .\\deploy.ps1', inFile('.\\deploy.ps1')],
    ['powershell', 'pwsh deploy.ps1', inFile('deploy.ps1')],
    ['powershell', './deploy.ps1', inFile('./deploy.ps1')],
    ['powershell', '.\\deploy.ps1', inFile('.\\deploy.ps1')],
    ['powershell', '& ./deploy.ps1', inFile('./deploy.ps1')],
    ['powershell', 'pwsh deploy', inFile('deploy')],
    ['powershell', 'pwsh --file deploy', inFile('deploy')],
    // The command given with -c is a command text, also when it names a .ps1
    ['powershell', "pwsh -c 'Write-Output a.ps1'", []],
    // A word known only at run time before -c may be the script file or an option: the shell is noted, and the command text is read too
    ['bash', 'bash "$OPTS" -c make', runTime('bash')],
    ['bash', 'bash "$OPTS" -c "$CMD"', [...runTime('bash'), ...runTime('$CMD')]],
    ['bash', "bash -c 'sudo ls'", []],
    ['bash', 'bash -lc make', []],
    ['bash', 'bash -s < deploy.sh', []],
    ['bash', "fish --command 'sudo ls'", []],
    ['bash', 'ls -la', []],
    ['powershell', 'eval x', []],
  ];
  if (powershells.length === 0) skip('the PowerShell commands of the unseen checks need PowerShell: none is installed');
  for (const [corpusShell, command, expected] of cases) {
    for (const shell of corpusShell === 'powershell' ? powershells : [corpusShell]) {
      await check(`unseen: ${command} (${shell})`, async () => {
        const answer = await commandManager.checkCommand(command, shell);
        // A failed check has no unseen list either, so it would pass the cases that expect none
        assert.notStrictEqual(answer.verdict, 'failed', `the check failed: ${JSON.stringify(answer)}`);
        assert.deepStrictEqual(answer.unseen ?? [], expected, `got ${JSON.stringify(answer)}`);
      });
    }
  }
}

export default async function runTests() {
  // The server, and the check in this process, read the config in this test's home, so only in a fresh test home
  if (!isTestHome()) {
    return skip('test-command-check-answers.js needs a fresh test home; run it through the runner: node test/run-all-tests.js test-command-check-answers.js');
  }
  const bash = [process.platform === 'win32' ? GIT_BASH : 'bash'].find((shell) => isShellAvailable(shell));
  const powershells = installedPowerShells();
  await testThroughServer(bash, powershells);
  await testUnseen(powershells);
  assert.deepStrictEqual(failures, [], `${failures.length} check(s) failed`);
  return true;
}

runIfMain(import.meta.url, runTests);
