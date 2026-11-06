/** Parser/consumer checks only: none of the command strings is executed. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test, { before } from 'node:test';
import { commandManager } from '../dist/command-manager.js';
import { configManager } from '../dist/config-manager.js';
import { programName } from '../dist/utils/shell.js';
import { readPosixCommands } from '../dist/utils/posix-commands.js';
import { withStartedPrograms } from '../dist/utils/command-wrappers.js';
import { isTestHome, withEnv } from './helpers/test-env.js';

const windows = process.platform === 'win32';
const ordinaryEnvironment = { WSL_DISTRO_NAME: undefined, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
const posixOnly = { skip: windows ? 'Literal backslash filenames require a POSIX filesystem; Windows path controls run separately' : false };

before(async () => {
  assert.ok(isTestHome(), 'Use the standard isolated test runner');
  await configManager.setValue('blockedCommands', ['fixture_blocked']);
});

test('explicit POSIX and CMD names retain ps1 while PowerShell removes it', async () => {
  await withEnv(ordinaryEnvironment, () => {
    for (const shellType of ['posix', 'cmd']) {
      assert.equal(programName('DEPLOY.PS1', shellType), 'deploy.ps1', shellType);
      assert.equal(programName('/tools/DEPLOY.PS1', shellType), 'deploy.ps1', shellType);
    }
    assert.equal(programName('DEPLOY.PS1', 'powershell'), 'deploy');
    assert.equal(programName('C:\\tools\\DEPLOY.PS1', 'powershell'), 'deploy');
  });
});

test('Windows executable suffixes and path spelling retain their existing rules', async () => {
  await withEnv({ ...ordinaryEnvironment, PATHEXT: '.COM;.EXE; .FoO' }, () => {
    for (const shellType of ['posix', 'cmd', 'powershell']) {
      assert.equal(programName('SC.EXE', shellType), windows ? 'sc' : 'sc.exe');
      assert.equal(programName('FORMAT.COM', shellType), windows ? 'format' : 'format.com');
      assert.equal(programName('TOOL.FOO', shellType), windows ? 'tool' : 'tool.foo');
    }
    assert.equal(programName('C:\\Windows\\SC.EXE', 'cmd'), windows ? 'sc' : 'sc.exe');
    assert.equal(programName(String.raw`bin\env`, 'posix'), windows ? 'env' : String.raw`bin\env`);
  });
  await withEnv({ ...ordinaryEnvironment, PATHEXT: '.CPL' }, () => {
    assert.equal(programName('SC.EXE', 'cmd'), windows ? 'sc' : 'sc.exe');
    assert.equal(programName('TOOL.CPL', 'cmd'), windows ? 'tool' : 'tool.cpl');
  });
});

test('calls without shell context keep the compatible legacy normalization', async () => {
  await withEnv(ordinaryEnvironment, () => {
    assert.equal(programName('DEPLOY.PS1'), 'deploy');
    assert.equal(programName(String.raw`C:\tools\DEPLOY.PS1`), 'deploy');
  });
});

test('literal POSIX backslash filenames do not become program wrappers', posixOnly, async () => {
  await withEnv(ordinaryEnvironment, async () => {
    for (const [literal, argumentsText] of [
      [String.raw`bin\env`, 'fixture_blocked'],
      [String.raw`bin\sudo`, 'fixture_blocked'],
      [String.raw`bin\timeout`, '1 fixture_blocked'],
    ]) {
      const text = `'${literal}' ${argumentsText}`;
      const reading = await readPosixCommands(text);
      assert.equal(reading.parseError, undefined);
      assert.equal(reading.commands[0].name, literal, 'The parser preserves the quoted filename');
      assert.deepEqual(withStartedPrograms(reading.commands, 'bash').map(command => command.name), [literal], text);
      assert.equal((await commandManager.checkCommand(text, 'bash')).verdict, 'allowed', text);
    }
    const nested = String.raw`env 'bin\sudo' fixture_blocked`;
    assert.equal((await commandManager.checkCommand(nested, 'bash')).verdict, 'allowed', nested);
  });
});

test('a literal POSIX backslash shell name does not enable fish wrappers', posixOnly, async () => {
  const reading = await readPosixCommands('or fixture_blocked');
  assert.deepEqual(withStartedPrograms(reading.commands, String.raw`bin\fish`).map(command => command.name), ['or']);
  assert.deepEqual(withStartedPrograms(reading.commands, 'fish').map(command => command.name), ['or', 'fixture_blocked']);
});

test('POSIX ps1 filenames neither alias a blocked name nor unwrap arguments', async () => {
  await withEnv(ordinaryEnvironment, async () => {
    for (const text of ['env.ps1 fixture_blocked', 'sudo.ps1 fixture_blocked', 'timeout.ps1 1 fixture_blocked']) {
      const reading = await readPosixCommands(text);
      assert.equal(reading.parseError, undefined);
      assert.equal(withStartedPrograms(reading.commands, 'bash').length, 1, text);
      assert.equal((await commandManager.checkCommand(text, 'bash')).verdict, 'allowed', text);
    }
    assert.equal((await commandManager.checkCommand('fixture_blocked.ps1 value', 'bash')).verdict, 'allowed');
    assert.equal((await commandManager.checkCommand('fixture_blocked.ps1 value', 'cmd')).verdict, 'allowed');
  });
});

test('real wrappers and exact blocked ps1 entries remain checked', async () => {
  await withEnv(ordinaryEnvironment, async () => {
    for (const text of ['env fixture_blocked', 'sudo fixture_blocked', 'timeout 1 fixture_blocked', 'env sudo fixture_blocked']) {
      assert.equal((await commandManager.checkCommand(text, 'bash')).verdict, 'blocked', text);
    }
    await configManager.setValue('blockedCommands', ['fixture_blocked.ps1']);
    try {
      assert.equal((await commandManager.checkCommand('fixture_blocked.ps1 value', 'bash')).verdict, 'blocked');
    } finally {
      await configManager.setValue('blockedCommands', ['fixture_blocked']);
    }
  });
});

test('declared WSL fixture retains repaired executable suffixes', posixOnly, () => {
  const module = new URL('../dist/utils/shell.js', import.meta.url).href;
  const code = `import { programName } from ${JSON.stringify(module)};
    console.log(JSON.stringify([
      programName('SC.EXE', 'posix'), programName('TOOL.CPL', 'posix'),
      programName('DEPLOY.PS1', 'posix'), programName('DEPLOY.PS1', 'powershell')
    ]));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', code], {
    env: { ...process.env, WSL_DISTRO_NAME: 'DeclaredFixtureOnly', PATHEXT: '.CPL' }, encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), ['sc', 'tool', 'deploy.ps1', 'deploy']);
});
