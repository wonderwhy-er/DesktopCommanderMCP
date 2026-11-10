/** Shared context transport, not a CMD interpreter. No supplied command is executed. */
import assert from 'node:assert/strict';
import { before, beforeEach, afterEach, test } from 'node:test';
import { commandManager } from '../dist/command-manager.js';
import { configManager } from '../dist/config-manager.js';
import { isTestHome } from './helpers/test-env.js';

const payload = '!tool! harmless';
let originalRead;
let originalConfig;
let calls;

before(() => assert.ok(isTestHome(), 'Use the standard isolated test home'));
beforeEach(() => {
  originalRead = commandManager.readCommands;
  originalConfig = configManager.getConfig;
  calls = [];
  configManager.getConfig = async () => ({ blockedCommands: ['!tool!'] });
  // A declared mode-aware reader boundary isolates the shared transport/memo contract.
  // Actual reader classification is checked by test-cmd-delayed-expansion-runtime.js.
  commandManager.readCommands = async (text, shell, { cmdDelayedExpansion = 'unknown' } = {}) => {
    calls.push({ text, shell, mode: cmdDelayedExpansion });
    if (text === payload) {
      return { functions: [], commands: [{
        name: '!tool!', words: [cmdDelayedExpansion === 'on' ? null : '!tool!', 'harmless'],
        written: ['!tool!', 'harmless'], wordTexts: ['!tool!', 'harmless'],
        start: 0, nameAtRunTime: cmdDelayedExpansion === 'on',
      }] };
    }
    return originalRead.call(commandManager, text, shell, { cmdDelayedExpansion });
  };
});
afterEach(() => {
  commandManager.readCommands = originalRead;
  configManager.getConfig = originalConfig;
});

test('unknown top-level context preserves prior literal blocking', async () => {
  assert.deepEqual(await commandManager.checkCommand(payload, 'cmd'), { verdict: 'blocked', name: '!tool!' });
  assert.equal(calls[0].mode, 'unknown');
});

test('explicit off reaches the reader and preserves literal blocking', async () => {
  const answer = await commandManager.checkCommand(payload, 'cmd', { cmdDelayedExpansion: 'off' });
  assert.deepEqual(answer, { verdict: 'blocked', name: '!tool!' });
  assert.equal(calls[0].mode, 'off');
});

test('explicit on reaches the reader as runtime rather than a literal block', async () => {
  assert.equal((await commandManager.checkCommand(payload, 'cmd', { cmdDelayedExpansion: 'on' })).verdict, 'unseen');
  assert.equal(calls[0].mode, 'on');
});

test('nested cmd forwards an explicit delayed-expansion flag', async () => {
  assert.equal((await commandManager.checkCommand(`cmd /d/v:on/c "${payload}"`, 'cmd')).verdict, 'unseen');
  assert(calls.some(({ text, mode }) => text === payload && mode === 'on'));
});

test('identical nested text checked on then off has distinct memo entries', async () => {
  const text = `cmd /v:on /c "${payload}" & cmd /v:off /c "${payload}"`;
  assert.deepEqual(await commandManager.checkCommand(text, 'cmd'), { verdict: 'blocked', name: '!tool!' });
  assert.deepEqual(calls.filter(({ text }) => text === payload).map(({ mode }) => mode), ['on', 'off']);
});

test('a new cmd without a known flag does not inherit outer on', async () => {
  assert.deepEqual(await commandManager.checkCommand(`cmd /c "${payload}"`, 'cmd', { cmdDelayedExpansion: 'on' }),
    { verdict: 'blocked', name: '!tool!' });
  assert(calls.some(({ text, mode }) => text === payload && mode === 'unknown'));
});

test('same-shell command text retains its existing on context', async () => {
  const answer = await commandManager.checkCommand(`gsudo "${payload}"`, 'cmd', { cmdDelayedExpansion: 'on' });
  assert.equal(answer.verdict, 'unseen');
  assert(calls.some(({ text, mode }) => text === payload && mode === 'on'));
});

test('POSIX script paths with forward slashes identify the sourced file on every host', () => {
  const name = 'bin/source';
  const found = { name, words: [name, 'fixture.sh'], written: [name, 'fixture.sh'],
    wordTexts: [name, 'fixture.sh'], start: 0, nameAtRunTime: false };
  assert.deepEqual(commandManager.scriptFiles(found, 'posix'), [{ what: 'fixture.sh', inFile: true }]);
});

test('POSIX script paths with backslashes follow the host path rules', () => {
  const name = String.raw`bin\source`;
  const found = { name, words: [name, 'fixture.sh'], written: [name, 'fixture.sh'],
    wordTexts: [name, 'fixture.sh'], start: 0, nameAtRunTime: false };
  const expected = process.platform === 'win32' ? [{ what: 'fixture.sh', inFile: true }] : [];
  assert.deepEqual(commandManager.scriptFiles(found, 'posix'), expected);
});
