/** CMD CALL delimiters must not hide the called program. All inputs are parsed, never executed. */
import assert from 'node:assert/strict';
import { createTestEnv, withEnv } from './helpers/test-env.js';
import { runIfMain } from './helpers/run-if-main.js';

const cases = [
  ['comma-attached program and argument', 'call,net user', ['call', 'net'], 'net'],
  ['semicolon-attached program and argument', 'call;sc query', ['call', 'sc'], 'sc'],
  ['equals-attached program and argument', 'call=net user', ['call', 'net'], 'net'],
  ['comma-attached program without arguments', 'call,net', ['call', 'net'], 'net'],
  ['semicolon-attached program without arguments', 'call;sc', ['call', 'sc'], 'sc'],
  ['ordinary CALL retains its program', 'call net user', ['net'], 'net'],
  ['quoted ordinary CALL retains its program', 'call "net" user', ['net'], 'net'],
  ['a mentioned CALL is only an argument', 'echo call,net user', ['echo'], undefined],
];

export default async function runTests() {
  const isolated = createTestEnv();
  try {
    await withEnv(isolated.env, async () => {
      const { configManager } = await import('../dist/config-manager.js');
      const { commandManager } = await import('../dist/command-manager.js');
      const { readCmdCommands } = await import('../dist/utils/cmd-commands.js');
      const { withStartedPrograms } = await import('../dist/utils/command-wrappers.js');
      const original = configManager.getConfig;
      configManager.getConfig = async () => ({ blockedCommands: ['net', 'sc'] });
      try {
        for (const [name, input, programs, blocked] of cases) {
          const reading = await readCmdCommands(input);
          assert.equal(reading.parseError, undefined, name);
          const running = withStartedPrograms(reading.commands, 'cmd');
          assert.deepEqual(running.map(command => command.name), programs, name);
          const check = await commandManager.checkCommand(input, 'cmd');
          assert.deepEqual(check, blocked ? { verdict: 'blocked', name: blocked } : { verdict: 'allowed' }, name);
          assert.equal(await commandManager.validateCommand(input, 'cmd'), blocked === undefined, name);
        }
      } finally {
        configManager.getConfig = original;
      }
    });
  } finally {
    isolated.cleanup();
  }
  console.log(`PASS: ${cases.length} CMD CALL parser/wrapper/consumer controls; no command executed`);
  return true;
}

runIfMain(import.meta.url, runTests);
