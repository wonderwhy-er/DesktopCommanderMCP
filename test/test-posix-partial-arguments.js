/** Parse/check only: no command string or requested shell in these cases is executed. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { isTestHome } from './helpers/test-env.js';

assert.ok(isTestHome(), 'run through the isolated test runner');
const { readPosixCommands } = await import('../dist/utils/posix-commands.js');
const { commandManager } = await import('../dist/command-manager.js');
const { withStartedPrograms } = await import('../dist/utils/command-wrappers.js');
const shell = '/not-installed/partial-posix-shell';
const complete = { name: 'echo', words: ['echo'], written: ['echo'], wordTexts: ['echo'],
  start: 0, nameAtRunTime: false };
const inspection = { argumentError: 'bounded argument inspection required' };
const forName = (name, words = [name]) => ({ ...complete, name, words,
  written: [...words], wordTexts: [...words], ...inspection });
const deferred = { ...complete, ...inspection };

test('ordinary oversized argument does not make a known executable unreadable', async () => {
  const reading = await readPosixCommands('echo {1..1001}');
  assert.equal(reading.parseError, undefined);
  assert.equal(reading.commands[0].name, 'echo');
  assert.match(reading.commands[0].argumentError, /brace expansion/);
  assert.deepEqual(reading.commands[0].words, ['echo'], 'only the inspected prefix is represented');
  assert.deepEqual(reading.commands[0].written, ['echo']);
  assert.deepEqual(reading.commands[0].wordTexts, ['echo']);
});

test('caller allows the ordinary oversized echo argument', async () => {
  assert.deepEqual(await commandManager.checkCommand('echo {1..1001}', shell), { verdict: 'allowed' });
});

test('required wrapper, command-name and unknown inspections still refuse over-budget words', async () => {
  for (const command of ['env {1..1001}', 'env echo {1..1001}', 'x{1..1001}',
    '$TOOL {1..1001}', '$MAYBE echo {1..1001}', 'su* echo {1..1001}',
    '$TOOL "$ARG" {1..1001}', 'eval {1..1001}', 'source {1..1001}',
    'trap {1..1001}', 'alias {1..1001}', 'builtin {1..1001}', 'noglob {1..1001}',
    'bash {1..1001}', 'runuser -u nobody {1..1001}', 'gsudo {1..1001}']) {
    const check = await commandManager.checkCommand(command, shell);
    assert.equal(check.verdict, 'failed', command);
    assert.equal(commandManager.isRefused(check), true, command);
  }
});

test('syntax errors remain refused beside oversized ordinary arguments', async () => {
  assert.equal((await commandManager.checkCommand('echo {1..1001} "unterminated', shell)).verdict, 'failed');
});

test('complete 1000-word readings keep full metadata without a deferred property', async () => {
  const reading = await readPosixCommands('echo {1..1000}');
  assert.equal(reading.parseError, undefined);
  assert.equal(reading.commands[0].words.length, 1001, 'the bound is per expansion, not total argv');
  assert.equal(Object.hasOwn(reading.commands[0], 'argumentError'), false);
  assert.deepEqual(reading.commands[0].words,
    ['echo', ...Array.from({ length: 1000 }, (_, index) => String(index + 1))]);
});

test('later commands and substitutions remain visible beside oversized ordinary arguments', async () => {
  for (const command of ['echo {1..1001}; sudo ls', 'echo {1..1001} $(sudo ls)',
    'echo {1..1001}; eval "sudo ls"', "eval 'echo {1..1001}; sudo ls'",
    '/not-installed/bash -c "echo {1..1001}; sudo ls"']) {
    assert.deepEqual(await commandManager.checkCommand(command, shell), { verdict: 'blocked', name: 'sudo' }, command);
  }
});

test('partial wrapper, text and script inspection cannot silently become complete or unseen', async () => {
  for (const command of ['env -S echo {1..1001}', 'runuser -u nobody echo {1..1001}',
    'runuser nobody {1..1001}', '/not-installed/bash -c echo {1..1001}',
    '/not-installed/bash --rcfile {1..1001} -ic echo']) {
    assert.equal((await commandManager.checkCommand(command, shell)).verdict, 'failed', command);
  }
});

test('dedup keeps complete and deferred records distinct', () => {
  const separate = withStartedPrograms([complete, deferred], shell);
  assert.equal(separate.length, 2, 'dedup cannot merge complete and incomplete records');
  assert.equal(Object.hasOwn(separate[0], 'argumentError'), false);
  assert.equal(separate[1].argumentError, inspection.argumentError);
});

test('existing consumer roles require complete arguments', async () => {
  const { textProgramReadings, sameShellProgramReadings } = await import('../dist/utils/command-wrappers.js');
  const { shellRuns, sameShellTexts } = await import('../dist/utils/inline-shells.js');
  const { shellScriptFiles } = await import('../dist/utils/shell-script-files.js');
  const { IncompleteArgumentsError } = await import('../dist/utils/command-reading.js');
  assert.throws(() => withStartedPrograms([{ ...deferred, nameAtRunTime: true }], shell), IncompleteArgumentsError);
  assert.throws(() => withStartedPrograms([forName('env', ['env', '-S'])], shell),
    IncompleteArgumentsError);
  assert.throws(() => textProgramReadings('runuser', ['runuser', 'nobody'], inspection), IncompleteArgumentsError);
  assert.throws(() => sameShellProgramReadings('gsudo', ['gsudo'], inspection), IncompleteArgumentsError);
  assert.throws(() => sameShellTexts(forName('gsudo'), 'posix'), IncompleteArgumentsError);
  assert.throws(() => shellRuns(forName('runuser')), IncompleteArgumentsError);
  assert.throws(() => shellRuns(forName('bash')), IncompleteArgumentsError);
  assert.throws(() => sameShellTexts(forName('eval'), 'posix'), IncompleteArgumentsError);
  assert.throws(() => shellScriptFiles('bash', [], inspection), IncompleteArgumentsError);
  assert.throws(() => commandManager.scriptFiles(forName('bash'), 'posix'), IncompleteArgumentsError);
  assert.deepEqual(shellScriptFiles('echo', [], inspection), [], 'ordinary program has no script-argument role');
});

test('only the shared typed argument error gets unreadable-input handling', async () => {
  const { IncompleteArgumentsError } = await import('../dist/utils/command-reading.js');
  const original = commandManager.readCommands;
  const originalLog = console.error;
  let logged = 0;
  console.error = () => { logged++; };
  try {
    commandManager.readCommands = async () => { throw new IncompleteArgumentsError('bounded input'); };
    assert.deepEqual(await commandManager.checkCommand('echo ok', shell),
      { verdict: 'failed', reason: 'bounded input' });
    assert.equal(logged, 0);
    commandManager.readCommands = async () => { throw new Error('bounded input'); };
    assert.deepEqual(await commandManager.checkCommand('echo ok', shell),
      { verdict: 'failed', reason: 'bounded input' });
    assert.equal(logged, 1, 'an unrelated exception retains the existing server-error path');
  } finally {
    commandManager.readCommands = original;
    console.error = originalLog;
  }
});

test('actual caller reaches only the controlled execution boundary for ordinary arguments', async () => {
  const { terminalManager } = await import('../dist/terminal-manager.js');
  const { startProcess } = await import('../dist/tools/improved-process-tools.js');
  const original = terminalManager.executeCommand;
  const calls = [];
  terminalManager.executeCommand = async (...args) => {
    calls.push(args);
    return { pid: 123456, output: 'controlled boundary only',
      processState: { isWaitingForInput: false, isFinished: false } };
  };
  try {
    const answer = await startProcess({ command: 'echo {1..1001}', shell, timeout_ms: 1 });
    assert.notEqual(answer.isError, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'echo {1..1001}');
    for (const command of ['env {1..1001}', 'echo {1..1001}; sudo ls']) {
      const refused = await startProcess({ command, shell, timeout_ms: 1 });
      assert.equal(refused.isError, true, command);
      assert.equal(refused.structuredContent.blocked, true, command);
    }
    assert.equal(calls.length, 1, 'no refused command reaches even the mock execution boundary');
  } finally {
    terminalManager.executeCommand = original;
  }
});

test('partial readings conservatively remove function exemptions without changing small readings', async () => {
  const small = 'sudo(){ echo ok; }; echo {1..3}; sudo';
  assert.equal((await commandManager.checkCommand(small, shell)).verdict, 'allowed');
  const large = 'sudo(){ echo ok; }; echo {1..1001}; sudo';
  assert.deepEqual((await readPosixCommands(large)).functions, []);
  assert.equal(commandManager.isRefused(await commandManager.checkCommand(large, shell)), true);
});
