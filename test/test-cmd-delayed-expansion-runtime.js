/** Parser/check-only regressions. None of these command strings is executed. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readCmdCommands } from '../dist/utils/cmd-commands.js';
import { commandManager } from '../dist/command-manager.js';
import { configManager } from '../dist/config-manager.js';
import { isTestHome } from './helpers/test-env.js';

test('delayed variable names are runtime values, including inside double quotes', async () => {
  for (const text of [
    '!DC_CMD_TOOL! fixture',
    '"!DC_CMD_TOOL!" fixture',
    'prefix!DC_CMD_TOOL!suffix fixture',
    "'!DC_CMD_TOOL!' fixture",
    '!!DC_CMD_TOOL!! fixture',
    '!DC_CMD_TOOL:old=new! fixture',
    '"!DC CMD TOOL!" fixture',
    '^!DC_CMD_TOOL^! fixture',
    '"^x!DC_CMD_TOOL!" fixture',
    '"!DC_CMD_TOOL!^x" fixture',
  ]) {
    const reading = await readCmdCommands(text, 'on');
    assert.equal(reading.parseError, undefined, text);
    assert.equal(reading.commands[0].nameAtRunTime, true, text);
    assert.equal(reading.commands[0].words[0], null, text);
  }
});

test('literal exclamation marks and delayed-phase caret escapes stay literal', async () => {
  for (const text of ['fixture!tool', '"fixture!tool"', '"^!DC_CMD_TOOL^!"', '^^!DC_CMD_TOOL!', '"!DC_CMD_TOOL^!"', '"!DC_CMD^_TOOL!"', 'fixture', '!!']) {
    const reading = await readCmdCommands(text, 'on');
    assert.equal(reading.parseError, undefined, text);
    assert.equal(reading.commands[0].nameAtRunTime, false, text);
    assert.notEqual(reading.commands[0].words[0], null, text);
  }
});

test('runtime arguments retain their written text without hiding a literal command name', async () => {
  const [command] = (await readCmdCommands('echo "!DC_CMD_TOOL!" "^!DC_CMD_LITERAL^!"', 'on')).commands;
  assert.equal(command.name, 'echo');
  assert.equal(command.nameAtRunTime, false);
  assert.deepEqual(command.words, ['echo', null, '^!DC_CMD_LITERAL^!']);
  assert.deepEqual(command.written, ['echo', '"!DC_CMD_TOOL!"', '"^!DC_CMD_LITERAL^!"']);
  assert.deepEqual(command.wordTexts, ['echo', '!DC_CMD_TOOL!', '^!DC_CMD_LITERAL^!']);
});

test('percent variables keep their existing runtime classification', async () => {
  for (const text of ['%DC_CMD_TOOL% fixture', '"%DC_CMD_TOOL%" fixture']) {
    const [command] = (await readCmdCommands(text)).commands;
    assert.equal(command.nameAtRunTime, true);
    assert.equal(command.words[0], null);
  }
});

test('groups and IF bodies keep runtime command offsets', async () => {
  const text = 'if exist fixture.txt (!DC_CMD_TOOL! fixture & echo literal!)';
  const reading = await readCmdCommands(text, 'on');
  assert.equal(reading.parseError, undefined);
  const dynamic = reading.commands.find(command => command.name === '!DC_CMD_TOOL!');
  assert.ok(dynamic);
  assert.equal(dynamic.nameAtRunTime, true);
  assert.equal(dynamic.start, text.indexOf('!DC_CMD_TOOL!'));
  assert.equal(reading.commands.find(command => command.name === 'echo').nameAtRunTime, false);
});

test('existing check reports unseen rather than claiming a delayed name was checked', async () => {
  assert.ok(isTestHome(), 'Run through the standard runner to isolate configuration');
  await configManager.setValue('blockedCommands', ['fixture_blocked', 'fixture!literal']);
  for (const text of ['!DC_CMD_TOOL! fixture', 'cmd /v:on /c "set DC_CMD_TOOL=fixture_blocked&& !DC_CMD_TOOL! fixture"']) {
    const answer = await commandManager.checkCommand(text, 'cmd', 'on');
    assert.equal(answer.verdict, 'unseen', text);
    assert.ok(answer.unseen.length > 0);
  }
  assert.equal((await commandManager.checkCommand('fixture!literal', 'cmd')).verdict, 'blocked');
  assert.equal((await commandManager.checkCommand('echo fixture!', 'cmd')).verdict, 'allowed');
});

test('a blocked literal bang filename stays blocked when CMD expansion is disabled', async t => {
  t.mock.method(configManager, 'getConfig', async () => ({ blockedCommands: ['!tool!'] }));
  for (const text of ['!tool! harmless', 'cmd /v:off /c "!tool! harmless"']) {
    assert.equal((await commandManager.checkCommand(text, 'cmd')).verdict, 'blocked', text);
  }
});

test('explicitly enabled delayed expansion does not falsely block the written variable name', async t => {
  t.mock.method(configManager, 'getConfig', async () => ({ blockedCommands: ['!tool!'] }));
  const answer = await commandManager.checkCommand('cmd /v:on /c "!tool! harmless"', 'cmd');
  assert.equal(answer.verdict, 'unseen');
});

test('reader off and unknown modes preserve literal names while on is runtime', async () => {
  const text = '!tool! harmless';
  for (const mode of ['off', 'unknown', undefined]) {
    const [command] = (await readCmdCommands(text, mode)).commands;
    assert.equal(command.nameAtRunTime, false, mode ?? 'default');
    assert.equal(command.words[0], '!tool!');
  }
  assert.equal((await readCmdCommands(text, 'on')).commands[0].nameAtRunTime, true);
  for (const mode of ['on', 'off', 'unknown']) {
    assert.equal((await readCmdCommands('%tool% harmless', mode)).commands[0].nameAtRunTime, true);
  }
});

test('real reader keeps identical nested text separate across CMD modes', async t => {
  t.mock.method(configManager, 'getConfig', async () => ({ blockedCommands: ['!tool!'] }));
  const payload = '!tool! harmless';
  for (const modes of [['on', 'off'], ['off', 'on']]) {
    const line = modes.map(mode => `cmd /v:${mode} /c "${payload}"`).join(' & ');
    assert.equal((await commandManager.checkCommand(line, 'cmd')).verdict, 'blocked');
  }
  assert.equal((await commandManager.checkCommand(`cmd /c "${payload}"`, 'cmd', 'on')).verdict, 'blocked');
  assert.equal((await commandManager.checkCommand(`gsudo "${payload}"`, 'cmd', 'on')).verdict, 'unseen');
});

test('FOR/F command text retains the explicitly enabled reader mode', async () => {
  const line = "for /f %i in ('!tool! harmless') do @echo %i";
  assert.equal((await readCmdCommands(line, 'on')).commands.find(command => command.name === '!tool!').nameAtRunTime, true);
  assert.equal((await readCmdCommands(line, 'off')).commands.find(command => command.name === '!tool!').nameAtRunTime, false);
});
