/** Parser/check-only: no command string in this file is executed. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { isTestHome } from './helpers/test-env.js';

assert.ok(isTestHome(), 'run through the isolated test runner');
const { readPosixCommands } = await import('../dist/utils/posix-commands.js');
const { commandManager } = await import('../dist/command-manager.js');

test('executable globs use the existing runtime inspection note', async () => {
  for (const input of ['su*', './su?', 's[uv]do', 'env su*', 'env {su*,ls}']) {
    const answer = await commandManager.checkCommand(input, 'bash');
    assert.equal(answer.verdict, 'unseen', input);
    const reading = await readPosixCommands(input);
    assert.ok(reading.commands[0].words.includes(null), input);
  }
});

test('quoted and escaped wildcard characters remain static names', async () => {
  for (const input of ["'su*'", '"su?"', 'su\\*', 's\\[uv\\]do']) {
    const reading = await readPosixCommands(input);
    assert.equal(reading.commands[0].nameAtRunTime, false, input);
    assert.notEqual(reading.commands[0].words[0], null, input);
    assert.equal((await commandManager.checkCommand(input, 'bash')).verdict, 'allowed', input);
  }
  assert.equal((await commandManager.checkCommand('echo su*', 'bash')).verdict, 'allowed');
});

test('static brace arguments reveal the program a wrapper starts', async () => {
  for (const input of ['env {sudo,ls}', 'command {sudo,ls}', 'nohup {sudo,ls}',
    'nice {sudo,ls}', 'env {,} sudo', 'env s{u,x}do', 'env {$X,sudo}']) {
    const answer = await commandManager.checkCommand(input, 'bash');
    assert.equal(answer.verdict, 'blocked', input);
    assert.equal(answer.name, 'sudo', input);
  }
});

test('expanded arguments keep aligned value, written text and command text arrays', async () => {
  const reading = await readPosixCommands('env {sudo,ls}');
  const command = reading.commands[0];
  assert.deepEqual(command.words, ['env', 'sudo', 'ls']);
  assert.deepEqual(command.written, ['env', '{sudo,ls}', '{sudo,ls}']);
  assert.deepEqual(command.wordTexts, ['env', 'sudo', 'ls']);
  assert.equal(command.start, 0);
});

test('ordinary, quoted and runtime brace arguments keep their existing meaning', async () => {
  for (const input of ['echo {sudo,ls}', 'env {echo,sudo}', "env '{sudo,ls}'", 'env {"",sudo}',
    "bash -c 'echo {sudo,ls}'"]) {
    assert.equal((await commandManager.checkCommand(input, 'bash')).verdict, 'allowed', input);
  }
  assert.equal((await commandManager.checkCommand('env {$X,ls}', 'bash')).verdict, 'unseen');
  for (const input of ['echo $(sudo)', "bash -c '{sudo,ls}'"]) {
    assert.equal((await commandManager.checkCommand(input, 'bash')).verdict, 'blocked', input);
  }
});

test('argument expansion retains the existing word and work limit', async () => {
  const reading = await readPosixCommands('env {1..1001}');
  assert.match(reading.parseError, /brace expansion/);
  assert.deepEqual(reading.commands, []);
});

test('a retained runtime alternative stops later arguments becoming command names', async () => {
  for (const input of ['{$X,"$X"} sudo', '{$X,$Y,"$X"} sudo', '$X "$Y" sudo']) {
    assert.equal((await commandManager.checkCommand(input, 'bash')).verdict, 'unseen', input);
    const reading = await readPosixCommands(input);
    assert.ok(reading.commands.every((command) => command.nameAtRunTime), input);
  }
});

test('RC direct-program wrappers and explicit startup-file notes retain their semantics', async () => {
  const direct = await commandManager.checkCommand('runuser -u nobody env {sudo,ls}', 'bash');
  assert.equal(direct.verdict, 'blocked');
  assert.equal(direct.name, 'sudo');
  assert.equal((await commandManager.checkCommand('runuser -u nobody echo {sudo,ls}', 'bash')).verdict, 'allowed');
  assert.equal((await commandManager.checkCommand('env {A=one,A=two} sudo', 'bash')).verdict, 'blocked');
  const startup = await commandManager.checkCommand("bash --rcfile setup.sh -ic 'echo {sudo,ls}'", 'bash');
  assert.equal(startup.verdict, 'unseen');
  assert.ok(startup.unseen.some((entry) => entry.what === 'setup.sh' && entry.inFile));
});
