/** Option/file readers and consumer only; none of these command strings is executed. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { isTestHome } from './helpers/test-env.js';

assert.ok(isTestHome(), 'run through the isolated test runner');
const { shellScriptFiles } = await import('../dist/utils/shell-script-files.js');
const { commandManager } = await import('../dist/command-manager.js');

test('each grouped o or O consumes its own following option value', () => {
  for (const options of [['-oo', 'pipefail', 'nounset'], ['-oO', 'pipefail', 'extglob'],
    ['-Oo', 'extglob', 'nounset'], ['+oo', 'pipefail', 'nounset'],
    ['-oOo', 'pipefail', 'extglob', 'nounset']]) {
    assert.deepEqual(shellScriptFiles('bash', [...options, 'deploy.sh']), ['deploy.sh'], options.join(' '));
  }
});

test('separated options and a single value in a flag cluster retain the filename', () => {
  for (const options of [['-o', 'pipefail', '-o', 'nounset'], ['-eo', 'pipefail'],
    ['-O', 'extglob'], ['+o', 'nounset'], ['--rcfile', 'init.sh']]) {
    assert.deepEqual(shellScriptFiles('bash', [...options, 'deploy.sh']), ['deploy.sh']);
  }
});

test('startup mode reads the matching lowercase o value within mixed clusters', () => {
  for (const options of [['-oo', 'pipefail', 'posix'], ['-Oo', 'extglob', 'posix']]) {
    assert.deepEqual(shellScriptFiles('bash', ['--rcfile', 'init.sh', '-i', ...options, '-c', 'echo safe']), []);
  }
  assert.deepEqual(shellScriptFiles('bash', [
    '--rcfile', 'init.sh', '--posix', '+oo', 'pipefail', 'posix', '-i', '-c', 'echo safe',
  ]), ['init.sh']);
  assert.deepEqual(shellScriptFiles('bash', [
    '--rcfile', 'init.sh', '-i', '-o', 'posix', '+o', 'posix', '-c', 'echo safe',
  ]), ['init.sh']);
});

test('command, stdin and positional-file boundaries retain their meaning', () => {
  assert.deepEqual(shellScriptFiles('bash', ['-oo', 'pipefail', 'nounset', '-c', 'echo safe', 'arg']), []);
  assert.deepEqual(shellScriptFiles('bash', ['-oo', 'pipefail', 'nounset', '-s', 'arg']), []);
  assert.deepEqual(shellScriptFiles('bash', ['--', 'deploy.sh', '-oo', 'pipefail', 'nounset']), ['deploy.sh']);
  assert.deepEqual(shellScriptFiles('bash', ['deploy.sh', '-oo', 'pipefail', 'nounset']), ['deploy.sh']);
});

test('a runtime filename stays unknown after all grouped option values', () => {
  assert.deepEqual(shellScriptFiles('bash', ['-oo', 'pipefail', 'nounset', null]), [null]);
  assert.deepEqual(shellScriptFiles('bash', ['-o', 'pipefail', null]), [null]);
});

test('explicit rcfile interaction, login and suppression controls are preserved', () => {
  assert.deepEqual(shellScriptFiles('bash', ['--rcfile', 'startup.sh', '-i', 'deploy.sh']),
    ['startup.sh', 'deploy.sh'], 'distinct startup and main files both remain visible');
  assert.deepEqual(shellScriptFiles('bash', ['--rcfile', 'init.sh', '-i', '-c', 'echo safe']), ['init.sh']);
  for (const options of [['--norc'], ['--login'], ['-l'], ['--posix'], ['-o', 'posix'], ['+i']]) {
    assert.deepEqual(shellScriptFiles('bash', ['--rcfile', 'init.sh', '-i', ...options, '-c', 'echo safe']), []);
  }
  assert.deepEqual(shellScriptFiles('bash', ['--rcfile', 'init.sh', '-c', 'echo safe']), []);
});

test('the existing command consumer names the actual file after grouped options', async () => {
  for (const command of ['bash -oo pipefail nounset deploy.sh', 'bash -oO pipefail extglob deploy.sh',
    'bash -o pipefail -o nounset deploy.sh']) {
    assert.deepEqual(await commandManager.checkCommand(command, 'bash'), {
      verdict: 'unseen', unseen: [{ what: 'deploy.sh', inFile: true }],
    }, command);
  }
  assert.equal((await commandManager.checkCommand('bash -oo pipefail nounset "$SCRIPT"', 'bash')).verdict, 'unseen');
});

test('runtime option values preserve script-selection uncertainty', () => {
  for (const options of [
    ['-oo', null, 'deploy.sh'],
    ['-oo', 'pipefail', null, 'deploy.sh'],
    ['-oO', null, 'extglob', 'deploy.sh'],
    ['+oo', null, 'nounset', 'deploy.sh'],
    ['-o', null, 'deploy.sh'],
    ['--rcfile', null, '-ic', 'echo ready'],
  ]) {
    assert.deepEqual(shellScriptFiles('bash', options), [null], JSON.stringify(options));
  }
});

test('the command consumer notes runtime option values instead of claiming complete inspection', async () => {
  for (const command of [
    'bash -oo $OPTIONS deploy.sh',
    'bash -oo "$OPTIONS" deploy.sh',
    'bash -oo pipefail "$OPTION" deploy.sh',
    'bash --rcfile "$RC" -ic "echo ready"',
  ]) {
    assert.deepEqual(await commandManager.checkCommand(command, 'bash'), {
      verdict: 'unseen', unseen: [{ what: 'bash', inFile: false }],
    }, command);
  }
});

test('quoted scalar option values leave a following command mode free of script files', () => {
  const args = ['-o', null, '-c', 'echo safe'];
  for (const value of ['"$X"', '"${X}"']) {
    const written = ['-o', value, '-c', '"echo safe"'];
    assert.deepEqual(shellScriptFiles('bash', args, { written }), [], value);
  }
  for (const value of ['$X', '"$@"', '"${values[@]}"']) {
    const written = ['-o', value, '-c', '"echo safe"'];
    assert.deepEqual(shellScriptFiles('bash', args, { written }), [null], value);
  }
  assert.deepEqual(shellScriptFiles('bash', args), [null], 'missing source metadata remains conservative');
});

test('the command consumer distinguishes quoted scalars from word-expanding option values', async () => {
  for (const value of ['"$X"', '"${X}"']) {
    assert.deepEqual(await commandManager.checkCommand(`bash -o ${value} -c "echo safe"`, 'bash'),
      { verdict: 'allowed' }, value);
  }
  for (const value of ['$X', '"$@"', '"${values[@]}"']) {
    assert.deepEqual(await commandManager.checkCommand(`bash -o ${value} -c "echo safe"`, 'bash'), {
      verdict: 'unseen', unseen: [{ what: 'bash', inFile: false }],
    }, value);
  }
});
