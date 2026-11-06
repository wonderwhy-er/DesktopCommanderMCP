/** Command-reader failure and quoting cases. Command strings are parsed, never executed. */
import assert from 'node:assert/strict';
import { commandManager } from '../dist/command-manager.js';
import { configManager } from '../dist/config-manager.js';
import { readCmdCommands } from '../dist/utils/cmd-commands.js';
import { readPosixCommands } from '../dist/utils/posix-commands.js';
import { withStartedPrograms } from '../dist/utils/command-wrappers.js';
import { PowerShellHelper } from '../dist/utils/powershell-commands.js';
import { braceWords } from '../dist/utils/brace-expansion.js';
import { runIfMain, skip } from './helpers/run-if-main.js';
import { isTestHome } from './helpers/test-env.js';

async function settingsFailureIsRefused() {
  const original = configManager.getConfig;
  try {
    for (const failure of [new Error('settings read failed'), 'settings storage unavailable']) {
      configManager.getConfig = async () => { throw failure; };
      assert.deepEqual(await commandManager.checkCommand('echo ready', 'bash'), {
        verdict: 'failed', reason: failure instanceof Error ? failure.message : failure,
      }, 'an unreadable blocklist must refuse even an otherwise allowed command');
    }
  } finally {
    configManager.getConfig = original;
  }
}

async function cmdConditionsAndRedirections() {
  const cases = [
    ['echo ready\r\nsc query', ['echo', 'sc']],
    ['echo data > sudo 2>&1 & sc query < input', ['echo', 'sc']],
    ['(echo data >> sudo) 2>errors & sc query', ['echo', 'sc']],
    ['if a==b sc query', ['sc']],
    ['if a== b sc query', ['sc']],
    ['if a == b sc query', ['sc']],
    ['if a ==b sc query', ['sc']],
    ['if a nonsense b', ['if']],
  ];
  for (const [text, names] of cases) {
    const reading = await readCmdCommands(text);
    assert.equal(reading.parseError, undefined, text);
    assert.deepEqual(reading.commands.map(command => command.name), names, text);
    for (const command of reading.commands) {
      assert.equal(command.words.length, command.written.length, text);
      assert.equal(command.words.length, command.wordTexts.length, text);
    }
  }
  const redirected = await readCmdCommands('echo data > sudo 2>&1');
  assert.deepEqual(redirected.commands[0].words, ['echo', 'data'],
    'redirection destinations and handle duplication are not executable arguments');
}

function unexpectedBraceInputFailureIsNotABudgetLimit() {
  const failure = new Error('character source failed');
  const character = { quoted: false, get char() { throw failure; } };
  assert.throws(() => braceWords([character]), error => error === failure,
    'an unexpected character read failure must propagate, not become normal expansion-limit exhaustion');
}

async function assignmentTextAndExpansionAreDistinct() {
  // A literal equals sign guarantees an assignment; one inside a runtime expansion does not.
  const cases = [
    [String.raw`env "FOO\=$TOOL" echo`, 'bash', false],
    [String.raw`env "'FOO=bar'$TOOL" echo`, 'bash', false],
    [String.raw`env "'prefix'${'${TOOL:=sudo}'}" echo`, 'bash', true],
    [String.raw`env "prefix'${'${TOOL:=sudo}'}" echo`, 'bash', true],
    ['env "`printf FOO=bar`$TOOL" echo', 'bash', true],
    ['env "%TOOL=VALUE%" echo', 'cmd', true],
    [String.raw`env "${'${TOOL:-(fallback=default)}'}" echo`, 'bash', true],
  ];
  for (const [text, shell, uncertain] of cases) {
    const reading = await (shell === 'cmd' ? readCmdCommands(text) : readPosixCommands(text));
    assert.equal(reading.parseError, undefined, text);
    const running = withStartedPrograms(reading.commands, shell);
    assert.equal(running.some(command => command.nameAtRunTime), uncertain, text);
    assert.ok(running.some(command => command.name === 'echo'), text);
  }
}

async function envSplitKeepsItsEscapesAndQuotes() {
  const cases = [
    [String.raw`env -S 'echo\c sudo'`, [['echo']]],
    [String.raw`env -S 'sudo\'`, [['sudo']]],
    [String.raw`env -S '"su\_do" ls'`, [['su do', 'ls']]],
    [String.raw`env -S '"sudo" ls'`, [['sudo', 'ls'], ['ls']]],
    [String.raw`env -S 'sudo\nls'`, [['sudo\nls']]],
  ];
  for (const [text, words] of cases) {
    const reading = await readPosixCommands(text);
    assert.equal(reading.parseError, undefined, text);
    const running = withStartedPrograms(reading.commands, 'bash');
    const started = running.filter(command => command.name !== 'env');
    assert.deepEqual(started.map(command => command.words), words, text);
  }
}

async function helperErrorRejectsWithoutLosingTheNextRequest() {
  // A protocol stand-in gives a real helper error, then a valid response with the same process/token.
  const script = `let count = 0;
    let pending = '';
    process.stdin.on('data', chunk => {
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (!line) continue;
        const { id, token } = JSON.parse(line);
        const answer = count++ === 0 ? { error: 'command lookup failed' } : { commands: [], functions: [] };
        process.stdout.write(JSON.stringify({ id, token, ...answer }) + '\\n');
      }
    });`;
  const helper = new PowerShellHelper(process.execPath, ['-e', script]);
  try {
    await assert.rejects(helper.read('Get-Date'), {
      message: 'PowerShell could not read the command: command lookup failed',
    });
    const pid = helper.pid;
    assert.ok(pid, 'an answered request error does not kill the helper');
    assert.deepEqual(await helper.read('Write-Output ready'), { commands: [], functions: [] });
    assert.equal(helper.pid, pid, 'the next request is read by the same helper');
  } finally {
    helper.stop();
  }
}

export default async function runTests() {
  if (!isTestHome()) return skip('the command integration checks require the isolated test runner');
  for (const check of [settingsFailureIsRefused, cmdConditionsAndRedirections,
    unexpectedBraceInputFailureIsNotABudgetLimit,
    assignmentTextAndExpansionAreDistinct, envSplitKeepsItsEscapesAndQuotes,
    helperErrorRejectsWithoutLosingTheNextRequest]) {
    await check();
    console.log(`PASS ${check.name}`);
  }
  return true;
}

runIfMain(import.meta.url, runTests);
