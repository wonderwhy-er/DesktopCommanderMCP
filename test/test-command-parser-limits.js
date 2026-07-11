import assert from 'assert';
import { commandManager } from '../dist/command-manager.js';

async function run() {
  const nestedCommand = `${'$('.repeat(8)}echo safe${')'.repeat(8)}`;
  assert.deepStrictEqual(commandManager.extractCommands(nestedCommand), ['echo']);

  const excessiveDepth = `${'$('.repeat(64)}echo safe${')'.repeat(64)}`;
  assert.throws(
    () => commandManager.extractCommands(excessiveDepth),
    /depth limit exceeded/
  );
  assert.strictEqual(
    await commandManager.validateCommand(excessiveDepth),
    false,
    'commands that exceed parser depth must fail closed'
  );

  const oversizedNestedCommand = `$(${`x`.repeat(4 * 1024 * 1024)})`;
  assert.throws(
    () => commandManager.extractCommands(oversizedNestedCommand),
    /budget limit exceeded/
  );
  assert.strictEqual(
    await commandManager.validateCommand(oversizedNestedCommand),
    false,
    'commands that exceed the parsing budget must fail closed'
  );

  console.log('PASS: command parser depth and work limits fail closed');
}

run().catch(error => {
  console.error(`FAIL: ${error.stack || error.message}`);
  process.exit(1);
});
