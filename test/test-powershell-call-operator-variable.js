import assert from 'node:assert/strict';
import { commandManager } from '../dist/command-manager.js';
import { runIfMain } from './helpers/run-if-main.js';

const DYNAMIC = '<dynamic-command>';

async function runTests() {
  console.log('Testing PowerShell call-operator variable handling...');

  const reported = commandManager.extractCommands('& $client init --help');
  assert.deepEqual(reported, [DYNAMIC],
    'a variable call target should not misclassify its first argument as the executable');
  assert.equal(reported.includes('init'), false,
    'the init subcommand must not be reported as the executable');

  for (const subcommand of ['doctor', 'run', '--help']) {
    const commands = commandManager.extractCommands(`& $client ${subcommand}`);
    assert.deepEqual(commands, [DYNAMIC],
      `dynamic target with ${subcommand} should remain unresolved`);
  }

  const chained = commandManager.extractCommands('echo before; & $client init --help; echo after');
  assert.deepEqual(chained, ['echo', DYNAMIC],
    'commands around a dynamic invocation should still be extracted without leaking its arguments');

  const blockedAfter = commandManager.extractCommands('& $client doctor --help; rm file');
  assert.ok(blockedAfter.includes(DYNAMIC) && blockedAfter.includes('rm'),
    'a real command after the dynamic invocation must still be inspected');

  const blockedBefore = commandManager.extractCommands('rm file; & $client doctor --help');
  assert.ok(blockedBefore.includes('rm') && blockedBefore.includes(DYNAMIC),
    'a real command before the dynamic invocation must still be inspected');

  const nestedBlocked = commandManager.extractCommands('& $client $(init)');
  assert.ok(nestedBlocked.includes(DYNAMIC), 'dynamic target should stay marked unresolved');
  assert.ok(nestedBlocked.includes('init'), 'nested command substitutions must still be inspected');

  const quotedText = commandManager.extractCommands('echo "& $client init --help"');
  assert.deepEqual(quotedText, ['echo'], 'quoted text must not be treated as a dynamic invocation');

  for (const dynamicTarget of [
    '& "$client" init --help',
    '& ($client) init --help',
    '& (${client}) init --help',
    '& $(Get-Command tool) init --help',
    '& { init --help }',
    '& @($client)[0] init --help',
    '& [scriptblock]::Create("init --help")'
  ]) {
    const commands = commandManager.extractCommands(dynamicTarget);
    assert.ok(commands.includes(DYNAMIC), `${dynamicTarget} should remain unresolved`);
    assert.equal(await commandManager.validateCommand(dynamicTarget), false,
      `${dynamicTarget} should fail closed`);
  }

  const literal = commandManager.extractCommands('& init --help');
  assert.deepEqual(literal, ['init'], 'a literal executable after the call operator must still be extracted');

  const quotedLiteral = commandManager.extractCommands('& "init" --help');
  assert.deepEqual(quotedLiteral, ['init'], 'a quoted literal executable must still be normalized and extracted');

  const singleQuotedLiteral = commandManager.extractCommands("& 'init' --help");
  assert.deepEqual(singleQuotedLiteral, ['init'], 'a single-quoted literal executable must still be normalized and extracted');

  const pathLiteral = commandManager.extractCommands('& /sbin/init --help');
  assert.deepEqual(pathLiteral, ['init'], 'a path-prefixed literal executable must still be normalized and extracted');

  const telemetry = commandManager.extractCommands('& $client init --help', true);
  assert.deepEqual(telemetry, [DYNAMIC],
    'telemetry extraction must not report the first argument as the executable either');

  const existingVariableCase = commandManager.extractCommands('$MYVAR ls');
  assert.ok(existingVariableCase.includes('ls'), 'existing non-call-operator variable behavior must stay unchanged');

  assert.equal(await commandManager.validateCommand('& $client doctor --help'), false,
    'an unresolved dynamic executable must fail closed even when its arguments are benign');

  console.log('✓ PowerShell dynamic call-operator tests passed');
  return true;
}

runIfMain(import.meta.url, runTests);
export default runTests;
