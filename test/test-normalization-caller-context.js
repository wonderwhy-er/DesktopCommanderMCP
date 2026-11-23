/** Shared caller-context regression: parses text only; none of these commands is executed. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandManager } from '../dist/command-manager.js';
import { configManager } from '../dist/config-manager.js';
import { shellRuns } from '../dist/utils/inline-shells.js';
import { isTestHome, withEnv } from './helpers/test-env.js';

async function withFixture(check) {
  assert.ok(isTestHome(), 'Use the standard isolated test home');
  const original = configManager.getConfig;
  configManager.getConfig = async () => ({ blockedCommands: ['fixture_blocked'] });
  try {
    return await withEnv({ WSL_DISTRO_NAME: undefined, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, check);
  } finally {
    configManager.getConfig = original;
  }
}

const posixOnly = {
  skip: process.platform === 'win32' ? 'Literal backslash filenames require a POSIX filesystem' : false,
};

for (const [name, command] of [
  ['source', String.raw`'bin\source' fixture`],
  ['eval', String.raw`'bin\eval' fixture_blocked`],
  ['bash', String.raw`'bin\bash' -c fixture_blocked`],
]) {
  test(`literal POSIX backslash ${name} path is not a builtin or shell`, posixOnly, () => withFixture(async () => {
    assert.deepEqual(await commandManager.checkCommand(command, 'bash'), { verdict: 'allowed' }, command);
  }));
}

for (const [name, command] of [
  ['source', 'source.ps1 fixture'],
  ['eval', 'eval.ps1 fixture_blocked'],
  ['bash', 'bash.ps1 -c fixture_blocked'],
]) {
  test(`literal POSIX ${name}.ps1 filename is not a builtin or shell`, () => withFixture(async () => {
    assert.deepEqual(await commandManager.checkCommand(command, 'bash'), { verdict: 'allowed' }, command);
  }));
}

test('real source still reports its file', () => withFixture(async () => {
  assert.deepEqual(await commandManager.checkCommand('source fixture', 'bash'), {
    verdict: 'unseen', unseen: [{ what: 'fixture', inFile: true }],
  });
}));

for (const [name, command] of [
  ['eval', 'eval fixture_blocked'],
  ['bash', 'bash -c fixture_blocked'],
  ['same-shell wrapper', 'gsudo fixture_blocked'],
]) {
  test(`real ${name} still checks its command text`, () => withFixture(async () => {
    assert.deepEqual(await commandManager.checkCommand(command, 'bash'), {
      verdict: 'blocked', name: 'fixture_blocked',
    });
  }));
}

const ps1NamedShell = {
  name: 'bash.ps1', words: ['bash.ps1', '-c', 'fixture_blocked'],
  written: ['bash.ps1', '-c', 'fixture_blocked'], wordTexts: ['bash.ps1', '-c', 'fixture_blocked'],
  start: 0, nameAtRunTime: false,
};

test('shellRuns keeps legacy readings when caller context is omitted', () => {
  assert.deepEqual(shellRuns(ps1NamedShell).texts, ['fixture_blocked']);
});

test('explicit POSIX caller context keeps a ps1 filename distinct from bash', () => {
  assert.deepEqual(shellRuns(ps1NamedShell, 'posix').texts, []);
});
