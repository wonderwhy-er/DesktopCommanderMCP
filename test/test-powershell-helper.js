/**
 * The PowerShell helper: one PowerShell process, kept running, that reads
 * PowerShell commands for the command check with PowerShell's own parser.
 *   - it starts at the first PowerShell check, not before: a POSIX check and
 *     loading the server start nothing
 *   - when it is killed, the next check starts a new one, and that check works
 *   - a stand-in helper that answers once and then stops answering fails the
 *     next check after HELPER_TIMEOUT_MS (5 seconds), and is stopped
 *   - a stand-in helper that never answers fails its first check after
 *     HELPER_START_TIMEOUT_MS (15 seconds, PowerShell's start included), and
 *     is stopped
 *
 * The first two need Windows PowerShell or PowerShell 7 and are skipped
 * without them. The last two measure time (they wait 5 and 15 seconds).
 */
import assert from 'assert';
import { configManager } from '../dist/config-manager.js';
import { runIfMain, skip } from './helpers/run-if-main.js';
import { isTestHome } from './helpers/test-env.js';
import { isRunning } from './helpers/process-tree.js';
import { installedPowerShells } from './helpers/powershell.js';
import { waitUntil } from './helpers/wait.js';

/** Slack for a loaded machine on top of the helper's time limit */
const TIMING_SLACK_MS = 5000;

/** A stand-in helper: it answers its first request with an empty reading, and then never again */
const ANSWERS_FIRST_REQUEST_ONLY = `
let answered = false;
process.stdin.on('data', (chunk) => {
  const line = String(chunk).split('\\n').find((text) => text.trim());
  if (answered || !line) return;
  answered = true;
  process.stdout.write(JSON.stringify({ id: JSON.parse(line).id, commands: [] }) + '\\n');
});`;

/** Reads with `helper`, expects it to fail with `message` after `limitMs`, and the helper's process to be stopped */
async function expectTimeout(helper, limitMs, message) {
  const started = Date.now();
  await assert.rejects(helper.read('Get-Date'), (error) => {
    assert.strictEqual(error.message, message);
    return true;
  });
  const waited = Date.now() - started;
  assert.ok(waited >= limitMs - 50, `failed only after the time limit (${waited} ms)`);
  assert.ok(waited < limitMs + TIMING_SLACK_MS, `failed soon after the time limit (${waited} ms)`);
  assert.strictEqual(helper.pid, undefined, 'the stand-in that stopped answering is stopped');
  console.log(`✓ the check failed after ${waited} ms with "${message}"`);
}

export default async function runTests() {
  // checkCommand() reads blockedCommands, so only in a fresh test home.
  if (!isTestHome()) {
    skip('test-powershell-helper.js sets blockedCommands; run it through the runner: node test/run-all-tests.js test-powershell-helper.js');
    return true;
  }
  const { commandManager } = await import('../dist/command-manager.js');
  const { PowerShellHelper, HELPER_TIMEOUT_MS, HELPER_START_TIMEOUT_MS, runningPowerShellHelpers } = await import('../dist/utils/powershell-commands.js');
  await configManager.setValue('blockedCommands', ['net', 'sudo']);

  const powershell = installedPowerShells()[0];
  if (!powershell) {
    skip('PowerShell helper start and restart: neither powershell nor pwsh is installed here');
  } else {
    console.log(`Test 1: the helper starts at the first PowerShell check (${powershell})`);
    assert.deepStrictEqual(runningPowerShellHelpers(), [], 'no helper runs before any check');
    const posix = await commandManager.checkCommand('sudo ls', 'bash');
    assert.strictEqual(posix.verdict, 'blocked', `a bash check works without PowerShell: ${JSON.stringify(posix)}`);
    assert.deepStrictEqual(runningPowerShellHelpers(), [], 'a bash check starts no helper');
    const first = await commandManager.checkCommand('net stop Spooler', powershell);
    assert.deepStrictEqual(first, { verdict: 'blocked', name: 'net' });
    assert.strictEqual(runningPowerShellHelpers().length, 1, 'the first PowerShell check starts one helper');
    const again = await commandManager.checkCommand('Write-Output "net is a word here"', powershell);
    assert.strictEqual(again.verdict, 'allowed', `a word inside a string is text: ${JSON.stringify(again)}`);
    assert.strictEqual(runningPowerShellHelpers().length, 1, 'the next check uses the same helper');
    console.log('✓ no helper before the first PowerShell check, then one, used again');

    console.log(`Test 2: a killed helper is replaced at the next check (${powershell})`);
    const helper = new PowerShellHelper(powershell);
    const before = await helper.read('Get-Date');
    assert.strictEqual(before.commands[0]?.words[0], 'Get-Date', `the helper reads: ${JSON.stringify(before)}`);
    const firstPid = helper.pid;
    assert.ok(firstPid && isRunning(firstPid), 'the helper runs after its first check');
    process.kill(firstPid);
    await waitUntil(() => helper.pid === undefined, 10000, 'the helper notices that its process ended');
    const after = await helper.read('net stop Spooler');
    assert.strictEqual(after.commands[0]?.words[0], 'net', `the next check works: ${JSON.stringify(after)}`);
    assert.ok(helper.pid && helper.pid !== firstPid, 'the next check started a new helper process');
    helper.stop();
    console.log('✓ after the kill, the next check started a new helper and got its answer');
  }

  console.log('Test 3: a helper that stops answering fails the next check after 5 seconds');
  const answersOnce = new PowerShellHelper(process.execPath, ['-e', ANSWERS_FIRST_REQUEST_ONLY]);
  const first = await answersOnce.read('Get-Date');
  assert.deepStrictEqual(first, { commands: [] }, 'the stand-in answers its first request');
  await expectTimeout(answersOnce, HELPER_TIMEOUT_MS, 'PowerShell did not answer in 5 seconds');

  console.log('Test 4: a helper that never answers fails its first check after 15 seconds, its start included');
  const neverAnswers = new PowerShellHelper(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)']);
  await expectTimeout(neverAnswers, HELPER_START_TIMEOUT_MS, 'PowerShell did not answer in 15 seconds');

  return true;
}

runIfMain(import.meta.url, runTests);
