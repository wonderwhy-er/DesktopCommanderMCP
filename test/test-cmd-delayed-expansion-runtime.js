/** Parser/check-only regressions. None of these command strings is executed. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readCmdCommands } from '../dist/utils/cmd-commands.js';
import { commandManager } from '../dist/command-manager.js';
import { configManager } from '../dist/config-manager.js';
import { isTestHome } from './helpers/test-env.js';
import { shellRuns } from '../dist/utils/inline-shells.js';

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
    '"^!DC_CMD_TOOL^!" fixture',
    '"!DC_CMD_TOOL^!" fixture',
    '"!DC_CMD^_TOOL!" fixture',
  ]) {
    const reading = await readCmdCommands(text, { cmdDelayedExpansion: 'on' });
    assert.equal(reading.parseError, undefined, text);
    assert.equal(reading.commands[0].nameAtRunTime, true, text);
    assert.equal(reading.commands[0].words[0], null, text);
  }
});

test('literal exclamation marks and delayed-phase caret escapes stay literal', async () => {
  for (const text of ['fixture!tool', '"fixture!tool"', '^^!DC_CMD_TOOL!', 'fixture', '!!']) {
    const reading = await readCmdCommands(text, { cmdDelayedExpansion: 'on' });
    assert.equal(reading.parseError, undefined, text);
    assert.equal(reading.commands[0].nameAtRunTime, false, text);
    assert.notEqual(reading.commands[0].words[0], null, text);
  }
});

test('runtime arguments retain their written text without hiding a literal command name', async () => {
  const [command] = (await readCmdCommands(
    'echo "!DC_CMD_TOOL!" "^!DC_CMD_LITERAL^!"', { cmdDelayedExpansion: 'on' }
  )).commands;
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
  const reading = await readCmdCommands(text, { cmdDelayedExpansion: 'on' });
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
  for (const text of [
    '!DC_CMD_TOOL! fixture',
    'cmd /v:on /c "set DC_CMD_TOOL=fixture_blocked&& !DC_CMD_TOOL! fixture"',
  ]) {
    const answer = await commandManager.checkCommand(text, 'cmd', { cmdDelayedExpansion: 'on' });
    assert.equal(answer.verdict, 'unseen', text);
    assert.ok(answer.unseen.length > 0);
  }
  assert.equal((await commandManager.checkCommand('fixture!literal', 'cmd')).verdict, 'blocked');
  assert.equal((await commandManager.checkCommand('echo fixture!', 'cmd')).verdict, 'allowed');
});

test('blocked literal bang names stay blocked in unknown and explicit-off contexts', async t => {
  t.mock.method(configManager, 'getConfig', async () => ({ blockedCommands: ['!tool!'] }));
  assert.equal((await commandManager.checkCommand('!tool! harmless', 'cmd')).verdict, 'blocked', 'default context');
  assert.equal((await commandManager.checkCommand('cmd /v:off /c "!tool! harmless"', 'cmd')).verdict,
    'blocked', 'nested explicit-off context');
  for (const [text, mode] of [
    ['!tool! harmless', 'unknown'],
    ['!tool! harmless', 'off'],
  ]) {
    const answer = await commandManager.checkCommand(text, 'cmd', { cmdDelayedExpansion: mode });
    assert.equal(answer.verdict, 'blocked', `${mode}: ${text}`);
  }
});

test('explicitly enabled delayed expansion does not falsely block the written variable name', async t => {
  t.mock.method(configManager, 'getConfig', async () => ({ blockedCommands: ['!tool!'] }));
  const answer = await commandManager.checkCommand('cmd /v:on /c "!tool! harmless"', 'cmd');
  assert.equal(answer.verdict, 'unseen');
});

test('reader off and unknown modes preserve literal names while on is runtime', async () => {
  const text = '!tool! harmless';
  for (const mode of ['off', 'unknown']) {
    const [command] = (await readCmdCommands(text, { cmdDelayedExpansion: mode })).commands;
    assert.equal(command.nameAtRunTime, false, mode);
    assert.equal(command.words[0], '!tool!');
  }
  const [defaultCommand] = (await readCmdCommands(text)).commands;
  assert.equal(defaultCommand.nameAtRunTime, false, 'default context');
  assert.equal(defaultCommand.words[0], '!tool!');
  assert.equal((await readCmdCommands(text, { cmdDelayedExpansion: 'on' })).commands[0].nameAtRunTime, true);
  for (const mode of ['on', 'off', 'unknown']) {
    const [command] = (await readCmdCommands('%tool% harmless', { cmdDelayedExpansion: mode })).commands;
    assert.equal(command.nameAtRunTime, true);
  }
});

test('real reader keeps identical nested text separate across CMD modes', async t => {
  t.mock.method(configManager, 'getConfig', async () => ({ blockedCommands: ['!tool!'] }));
  const payload = '!tool! harmless';
  for (const modes of [['on', 'off'], ['off', 'on']]) {
    const line = modes.map(mode => `cmd /v:${mode} /c "${payload}"`).join(' & ');
    assert.equal((await commandManager.checkCommand(line, 'cmd')).verdict, 'blocked');
  }
  const newShell = await commandManager.checkCommand(`cmd /c "${payload}"`, 'cmd', { cmdDelayedExpansion: 'on' });
  const sameShell = await commandManager.checkCommand(`gsudo "${payload}"`, 'cmd', { cmdDelayedExpansion: 'on' });
  assert.equal(newShell.verdict, 'blocked');
  assert.equal(sameShell.verdict, 'unseen');
});

test('FOR/F command text retains the explicitly enabled reader mode', async () => {
  const line = "for /f %i in ('!tool! harmless') do @echo %i";
  const enabled = await readCmdCommands(line, { cmdDelayedExpansion: 'on' });
  const disabled = await readCmdCommands(line, { cmdDelayedExpansion: 'off' });
  assert.equal(enabled.commands.find(command => command.name === '!tool!').nameAtRunTime, true);
  assert.equal(disabled.commands.find(command => command.name === '!tool!').nameAtRunTime, false);
});

test('runtime CMD options retain an inspection note and cannot erase literal blocking', async t => {
  const text = 'cmd /v:on /%sw% /c "!calc! x"';
  const [found] = (await readCmdCommands(text)).commands;
  const run = shellRuns(found);
  assert.equal(run.cmdDelayedExpansion, 'unknown', 'a runtime option may override the earlier mode');
  assert.equal(run.file, null, 'the unknown option must remain visible as uninspected command text');
  t.mock.method(configManager, 'getConfig', async () => ({ blockedCommands: ['calc'] }));
  const answer = await commandManager.checkCommand(text, 'cmd');
  assert.equal(answer.verdict, 'unseen', 'do not claim this runtime-selected command was fully checked');
  assert.ok(answer.unseen.some(item => item.what === 'cmd' && !item.inFile));
  t.mock.method(configManager, 'getConfig', async () => ({ blockedCommands: ['!tool!'] }));
  assert.equal((await commandManager.checkCommand('cmd /v:on /%sw% /c "!tool! x"', 'cmd')).verdict,
    'blocked', 'unknown mode retains the literal-name policy');
});

test('quoted caret command names are inspected as runtime names when CMD expansion is on', async t => {
  t.mock.method(configManager, 'getConfig', async () => ({ blockedCommands: ['EXPANDED_TOOL'] }));
  const direct = await commandManager.checkCommand('"!DC_CMD^_TOOL!" fixture', 'cmd', { cmdDelayedExpansion: 'on' });
  assert.equal(direct.verdict, 'unseen', 'a real quoted executable retains runtime classification');
  const answer = await commandManager.checkCommand('cmd /v:on /c "!DC_CMD^_TOOL! fixture"', 'cmd');
  assert.equal(answer.verdict, 'unseen', 'the command-position caret does not prevent variable expansion');
  assert.ok(answer.unseen.some(item => item.what.includes('DC_CMD')));
});

for (const text of [
  'calc/"!DC_CMD^_TOOL!"', 'calc,"!DC_CMD^_TOOL!"',
  'calc/!x!', 'calc,!x!', 'calc;!x!', 'calc=!x!', 'calc/"!x!"', 'calc,"!x!"',
]) {
  test(`literal executable stays blocked before a runtime-looking suffix: ${text}`, async testContext => {
    testContext.mock.method(configManager, 'getConfig', async () => ({ blockedCommands: ['calc'] }));
    const [found] = (await readCmdCommands(text, { cmdDelayedExpansion: 'on' })).commands;
    assert.equal(found.name, 'calc');
    assert.equal(found.nameAtRunTime, false, 'an argument suffix is not part of the executable');
    assert.equal(found.words[0], 'calc');
    const answer = await commandManager.checkCommand(text, 'cmd', { cmdDelayedExpansion: 'on' });
    assert.deepEqual(answer, { verdict: 'blocked', name: 'calc' });
  });
}

test('named CMD options are read without changing the caller context', async t => {
  t.mock.method(configManager, 'getConfig', async () => ({ blockedCommands: ['!tool!'] }));
  const enabled = Object.freeze({ cmdDelayedExpansion: 'on' });
  const disabled = Object.freeze({ cmdDelayedExpansion: 'off' });
  assert.equal((await commandManager.checkCommand('!tool! harmless', 'cmd', disabled)).verdict, 'blocked');
  assert.equal((await commandManager.checkCommand('!tool! harmless', 'cmd', enabled)).verdict, 'unseen');
  assert.equal((await readCmdCommands('!tool! harmless', enabled)).commands[0].nameAtRunTime, true);
  assert.deepEqual(enabled, { cmdDelayedExpansion: 'on' });
  assert.deepEqual(disabled, { cmdDelayedExpansion: 'off' });
});

test('a runtime attached argument does not erase the literal executable or its argument spelling', async () => {
  const [found] = (await readCmdCommands('calc/!x!', { cmdDelayedExpansion: 'on' })).commands;
  assert.equal(found.nameAtRunTime, false);
  assert.deepEqual(found.words, ['calc', null]);
  assert.deepEqual(found.written, ['calc', '/!x!']);
  assert.deepEqual(found.wordTexts, ['calc', '/!x!']);
});

test('quoted and drive-path executable variables remain runtime names', async testContext => {
  testContext.mock.method(configManager, 'getConfig', async () => ({ blockedCommands: ['calc'] }));
  for (const text of ['"calc/!x!" fixture', 'C:/folder/!x!.exe fixture', '!x!/literal']) {
    const [found] = (await readCmdCommands(text, { cmdDelayedExpansion: 'on' })).commands;
    assert.equal(found.nameAtRunTime, true, text);
    assert.equal(found.words[0], null, text);
    assert.equal((await commandManager.checkCommand(text, 'cmd', { cmdDelayedExpansion: 'on' })).verdict,
      'unseen', text);
  }
});

for (const mode of ['unknown', 'off', 'on']) {
  test(`a quoted static executable consumes one caret layer in ${mode} mode`, async testContext => {
    testContext.mock.method(configManager, 'getConfig', async () => ({ blockedCommands: ['calc'] }));
    const text = '"ca^lc" fixture';
    const options = { cmdDelayedExpansion: mode };
    const [found] = (await readCmdCommands(text, options)).commands;
    assert.equal(found.name, 'calc');
    assert.equal(found.nameAtRunTime, false);
    assert.equal(found.words[0], 'calc');
    assert.equal(found.written[0], '"ca^lc"');
    assert.deepEqual(await commandManager.checkCommand(text, 'cmd', options), { verdict: 'blocked', name: 'calc' });
  });
}

test('a doubled executable caret preserves one literal caret instead of matching the plain name', async testContext => {
  const text = '"fi^^xture" fixture';
  const [found] = (await readCmdCommands(text, { cmdDelayedExpansion: 'on' })).commands;
  assert.equal(found.name, 'fi^xture');
  assert.equal(found.nameAtRunTime, false);
  let blockedCommands = ['fixture'];
  testContext.mock.method(configManager, 'getConfig', async () => ({ blockedCommands }));
  assert.equal((await commandManager.checkCommand(text, 'cmd', { cmdDelayedExpansion: 'on' })).verdict, 'allowed');
  blockedCommands = ['fi^xture'];
  assert.deepEqual(await commandManager.checkCommand(text, 'cmd', { cmdDelayedExpansion: 'on' }),
    { verdict: 'blocked', name: 'fi^xture' });
});

test('quoted argument carets retain their separate argument spelling', async () => {
  const [found] = (await readCmdCommands('echo "ca^lc"', { cmdDelayedExpansion: 'on' })).commands;
  assert.equal(found.name, 'echo');
  assert.deepEqual(found.words, ['echo', 'ca^lc']);
  assert.deepEqual(found.wordTexts, ['echo', 'ca^lc']);
});

test('a variable within the whole executable stays uncovered without guessing its environment', async testContext => {
  testContext.mock.method(configManager, 'getConfig', async () => ({ blockedCommands: ['calc'] }));
  const answer = await commandManager.checkCommand('cmd /v:on /c "calc!x!"', 'cmd');
  assert.equal(answer.verdict, 'unseen');
  assert.deepEqual(answer.unseen, [{ what: 'calc!x!', inFile: false }]);
});

for (const text of ['calc/%x%', 'calc,%x%', 'calc;%x%', 'calc=%x%', 'calc/"%x%"', 'calc,"%x%"']) {
  test(`a percent-variable argument cannot hide a blocked literal executable: ${text}`, async testContext => {
    testContext.mock.method(configManager, 'getConfig', async () => ({ blockedCommands: ['calc'] }));
    for (const options of [{}, { cmdDelayedExpansion: 'off' }, { cmdDelayedExpansion: 'on' }]) {
      const [found] = (await readCmdCommands(text, options)).commands;
      assert.equal(found.name, 'calc');
      assert.equal(found.nameAtRunTime, false);
      assert.equal(found.words[0], 'calc');
      assert.equal(found.words[1], null, 'the attached argument remains runtime information');
      assert.deepEqual(await commandManager.checkCommand(text, 'cmd', options), { verdict: 'blocked', name: 'calc' });
    }
  });
}

test('percent variables beginning in the executable remain runtime across a substitution delimiter', async () => {
  for (const text of ['%x% fixture', '%x:old=new% fixture', 'C:/%x%/fixture.exe']) {
    const [found] = (await readCmdCommands(text)).commands;
    assert.equal(found.nameAtRunTime, true, text);
    assert.equal(found.words[0], null, text);
  }
});

test('a percent runtime argument retains source text independently from its literal executable', async () => {
  const [found] = (await readCmdCommands('calc/%x%')).commands;
  assert.deepEqual(found.words, ['calc', null]);
  assert.deepEqual(found.written, ['calc', '/%x%']);
  assert.deepEqual(found.wordTexts, ['calc', '/%x%']);
});
