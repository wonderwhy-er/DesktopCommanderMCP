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

  for (const escapedQuotedTarget of [
    '& "r`m" file',
    "& 'r''m' file"
  ]) {
    const commands = commandManager.extractCommands(escapedQuotedTarget);
    assert.ok(commands.includes(DYNAMIC), `${escapedQuotedTarget} should remain unresolved`);
    assert.equal(await commandManager.validateCommand(escapedQuotedTarget), false,
      `${escapedQuotedTarget} should fail closed instead of comparing encoded literal text`);
  }

  const assignedDynamic = commandManager.extractCommands('$out = & $client init --help');
  assert.ok(assignedDynamic.includes(DYNAMIC), 'assignment call operator should detect the dynamic target');
  assert.equal(assignedDynamic.includes('init'), false, 'assignment must not misclassify the first argument as the executable');
  assert.equal(assignedDynamic.includes('='), false, 'assignment syntax must not be extracted as a command');

  const scriptblockDynamic = commandManager.extractCommands('if ($ok) { & $client init --help }');
  assert.ok(scriptblockDynamic.includes(DYNAMIC), 'scriptblock call operator should detect the dynamic target');
  assert.equal(scriptblockDynamic.includes('init'), false, 'scriptblock must not misclassify the first argument as the executable');

  const multilineDynamic = commandManager.extractCommands('echo before\n& $client init --help');
  assert.ok(multilineDynamic.includes('echo'), 'a real command before a newline call operator must still be extracted');
  assert.ok(multilineDynamic.includes(DYNAMIC), 'newline call operator should detect the dynamic target');
  assert.equal(multilineDynamic.includes('init'), false, 'newline call operator must not leak the first argument as a command');

  const assignedLiteral = commandManager.extractCommands('$out = & init --help');
  assert.ok(assignedLiteral.includes('init'), 'assignment call operator should preserve an unquoted literal target');
  assert.equal(assignedLiteral.includes(DYNAMIC), false, 'literal assignment target must not become dynamic');

  const scriptblockLiteral = commandManager.extractCommands('if ($ok) { & "init" --help }');
  assert.ok(scriptblockLiteral.includes('init'), 'scriptblock call operator should preserve a quoted literal target');
  assert.equal(scriptblockLiteral.includes(DYNAMIC), false, 'quoted literal scriptblock target must not become dynamic');

  const multilineLiteral = commandManager.extractCommands('echo before\n& "init" --help');
  assert.ok(multilineLiteral.includes('echo'), 'newline literal call must preserve the preceding command');
  assert.ok(multilineLiteral.includes('init'), 'newline literal call should preserve the static target');
  assert.equal(multilineLiteral.includes(DYNAMIC), false, 'newline literal target must not become dynamic');

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
