/** Check script inspection notes without executing supplied commands. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandManager } from '../dist/command-manager.js';
import { configManager } from '../dist/config-manager.js';
import { readPosixCommands } from '../dist/utils/posix-commands.js';
import { shellRuns } from '../dist/utils/inline-shells.js';
import { isTestHome, withEnv } from './helpers/test-env.js';

async function withFixture(check) {
  assert.ok(isTestHome(), 'Use the standard isolated test home');
  const original = configManager.getConfig;
  configManager.getConfig = async () => ({ blockedCommands: ['fixture_blocked'] });
  try {
    return await withEnv({ WSL_DISTRO_NAME: undefined }, check);
  } finally {
    configManager.getConfig = original;
  }
}

const fileNote = (what) => ({ what, inFile: true });

test('pure runuser shell reading retains the known script filename', () => withFixture(async () => {
  const reading = await readPosixCommands('runuser root -- deploy.sh');
  assert.equal(reading.parseError, undefined);
  assert.equal(shellRuns(reading.commands[0]).file, 'deploy.sh');
}));

for (const [name, command, notes] of [
  ['known runuser script', 'runuser root -- deploy.sh', [fileNote('deploy.sh')]],
  ['quoted runuser script', 'runuser root -- "deploy file.sh"', [fileNote('deploy file.sh')]],
  ['known su script', 'su root -- deploy.sh', [fileNote('deploy.sh')]],
  ['ordinary shell script', 'bash deploy.sh', [fileNote('deploy.sh')]],
  ['startup and main script', 'bash --rcfile startup.sh -i deploy.sh',
    [fileNote('startup.sh'), fileNote('deploy.sh')]],
]) {
  test(`${name} reports the exact unseen payload once`, () => withFixture(async () => {
    assert.deepEqual(await commandManager.checkCommand(command, 'bash'), { verdict: 'unseen', unseen: notes });
  }));
}

test('a runtime script remains unknown in the pure shell reading', () => withFixture(async () => {
  const reading = await readPosixCommands('runuser root -- "$SCRIPT"');
  assert.equal(reading.parseError, undefined);
  assert.equal(shellRuns(reading.commands[0]).file, null);
}));

for (const [name, command] of [
  ['direct -u program', 'runuser -u nobody ./deploy.sh'],
  ['direct -u literal argument', 'runuser -u nobody echo fixture_blocked'],
  ['explicit command trailing argument', 'runuser root -c "echo safe" deploy.sh'],
  ['forwarded command text', 'runuser root -- -c "echo safe"'],
  ['stdin mode', 'runuser root -- -s'],
]) {
  test(`${name} does not invent a script-file note`, () => withFixture(async () => {
    assert.deepEqual(await commandManager.checkCommand(command, 'bash'), { verdict: 'allowed' });
  }));
}

test('forwarded blocked command text is still refused', () => withFixture(async () => {
  assert.deepEqual(await commandManager.checkCommand('runuser root -- -c fixture_blocked', 'bash'), {
    verdict: 'blocked', name: 'fixture_blocked',
  });
}));

test('ordinary POSIX backslash program is not reported as a forwarded shell script', {
  skip: process.platform === 'win32' ? 'Literal backslash filename requires a POSIX filesystem' : false,
}, () => withFixture(async () => {
  assert.deepEqual(await commandManager.checkCommand(String.raw`'bin\bash' deploy.sh`, 'bash'), {
    verdict: 'allowed',
  });
}));
