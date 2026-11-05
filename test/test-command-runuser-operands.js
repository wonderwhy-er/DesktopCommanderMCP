/** Parser-only runuser option/operand regressions; no command is executed. */
import assert from 'node:assert/strict';
import { textProgramReadings, shellOptionReadings, withStartedPrograms } from '../dist/utils/command-wrappers.js';
import { shellRuns } from '../dist/utils/inline-shells.js';
import { runIfMain, skip } from './helpers/run-if-main.js';
import { isTestHome } from './helpers/test-env.js';

function found(words, wordTexts = words.map(word => word ?? '$TOOL')) {
  return { name: words[0], words, wordTexts, written: wordTexts, start: 17, nameAtRunTime: false };
}

export default async function runTests() {
  const result = textProgramReadings('runuser', ['runuser', '-u', 'nobody', 'env', 'sudo', 'ls']);
  assert.deepEqual(result.readings.programs, [{ program: 'env', at: 3 }],
    'runuser -u identifies its direct program instead of dropping arguments in a shell text');
  assert.deepEqual(result.readings.texts, []);
  const direct = [
    ['runuser', '-u', 'nobody', 'env', 'sudo', 'ls'],
    ['runuser', '-unobody', 'env', 'sudo', 'ls'],
    ['runuser', '--user=nobody', 'env', 'sudo', 'ls'],
    ['runuser', '--user', 'nobody', '--', 'env', 'sudo', 'ls'],
    ['runuser', '-u', 'nobody', '-g', 'nogroup', 'env', 'sudo', 'ls'],
  ];
  for (const words of direct) {
    const root = found(words);
    const running = withStartedPrograms([root], 'bash');
    assert.deepEqual(running.map(c => c.name), ['runuser', 'env', 'sudo', 'ls']);
    const at = words.indexOf('env');
    assert.deepEqual(running[1], { ...root, name: 'env', words: words.slice(at),
      written: root.written.slice(at), wordTexts: root.wordTexts.slice(at) });
    assert.deepEqual(shellRuns(root), { shell: 'sh', texts: [] }, 'direct argv is not reparsed as shell text');
  }
  const raw = found(['runuser', '-u', 'nobody', 'echo', 'sudo'], ['runuser', '-u', 'nobody', 'echo', 'sudo']);
  raw.written[4] = "'sudo'";
  const child = withStartedPrograms([raw], 'bash')[1];
  assert.deepEqual(child.written, ['echo', "'sudo'"]);
  assert.deepEqual(child.words, ['echo', 'sudo']);
  for (const words of [
    ['runuser', '-u', 'nobody', 'env', null, 'ls'],
    ['runuser', '-u', 'nobody', null, 'ls'],
  ]) {
    const root = found(words);
    const running = withStartedPrograms([root], 'bash');
    assert(running.some(c => c.nameAtRunTime && c.name === '$TOOL'), 'runtime programs remain runtime programs');
    assert.deepEqual(running[1].words, words.slice(3), 'trailing runtime argv is retained');
  }
  for (const program of ['runuser', 'su']) {
    assert.deepEqual(shellRuns(found([program, 'nobody', '-c', 'echo safe', 'sudo'])),
      { shell: 'sh', texts: ['echo safe'] }, `${program} -c remains a single text`);
  }
  assert.deepEqual(shellOptionReadings('bash', ['bash', '-c', 'echo safe', 'sudo']).texts,
    [{ text: 'echo safe', at: 2, after: 3 }], 'bash -c keeps its single command text');
  assert.deepEqual(withStartedPrograms([found(['runuser', '-u', 'nobody'])], 'bash').map(c => c.name), ['runuser']);
  assert.deepEqual(withStartedPrograms([found(['sudo', '-u', 'nobody', 'echo', 'safe'])], 'bash').map(c => c.name),
    ['sudo', 'echo'], 'sudo wrapper handling is unchanged');
  console.log('PASS: runuser direct argv, option forms, raw/runtime operands and su/bash/sudo controls');

  if (!isTestHome()) return skip('runuser verdict checks require a fresh test home');
  const { configManager } = await import('../dist/config-manager.js');
  const { commandManager } = await import('../dist/command-manager.js');
  await configManager.setValue('blockedCommands', ['sudo']);
  const verdicts = [
    ['runuser -u nobody env sudo ls', { verdict: 'blocked', name: 'sudo' }],
    ['runuser --user=nobody -- env sudo ls', { verdict: 'blocked', name: 'sudo' }],
    ['runuser -u nobody echo sudo', { verdict: 'allowed' }],
    ["runuser -u nobody env '$TOOL'", { verdict: 'allowed' }],
    ["runuser nobody -c 'echo safe' sudo", { verdict: 'allowed' }],
    ["runuser nobody -c 'sudo ls'", { verdict: 'blocked', name: 'sudo' }],
    ["su nobody -c 'echo safe' sudo", { verdict: 'allowed' }],
    ["bash -c 'echo safe' sudo", { verdict: 'allowed' }],
    ['runuser -u nobody env "$TOOL"', { verdict: 'unseen', unseen: [{ what: '"$TOOL"', inFile: false }] }],
    ['runuser -u nobody env "unterminated', { verdict: 'failed', reason: 'unterminated double quote' }],
  ];
  for (const [command, expected] of verdicts) {
    const actual = await commandManager.checkCommand(command, 'bash');
    assert.deepEqual(actual, expected, command);
    console.log(`PASS: ${command} -> ${JSON.stringify(actual)}`);
  }
  return true;
}

runIfMain(import.meta.url, runTests);
