import assert from 'assert';
import fs from 'fs/promises';
import { commandManager } from '../dist/command-manager.js';
import { configManager } from '../dist/config-manager.js';
import { trackToolCall } from '../dist/utils/trackTools.js';
import { TOOL_CALL_FILE } from '../dist/config.js';

async function testCommandValidationFailClosed() {
  const originalExtract = commandManager.extractCommands.bind(commandManager);
  const prevMode = await configManager.getValue('commandValidationMode');

  try {
    commandManager.extractCommands = () => { throw new Error('parser boom'); };
    await configManager.setValue('commandValidationMode', 'strict');
    const strictResult = await commandManager.validateCommandWithDetails('ls -la');
    assert.strictEqual(strictResult.allowed, false, 'strict mode should fail closed');
    assert.ok((strictResult.reason || '').includes('strict mode'), 'strict mode should provide actionable reason');

    await configManager.setValue('commandValidationMode', 'legacy');
    const legacyResult = await commandManager.validateCommandWithDetails('ls -la');
    assert.strictEqual(legacyResult.allowed, true, 'legacy mode should preserve fail-open behavior');
  } finally {
    commandManager.extractCommands = originalExtract;
    await configManager.setValue('commandValidationMode', prevMode ?? 'strict');
  }
}

async function testToolCallRedaction() {
  const prevMode = await configManager.getValue('toolCallLoggingMode');
  await configManager.setValue('toolCallLoggingMode', 'redacted');

  try {
    const secret = 'super-secret-token-123';
    await trackToolCall('unit_test_tool', {
      command: `echo ${secret}`,
      apiKey: secret,
      harmless: 'value'
    });

    const log = await fs.readFile(TOOL_CALL_FILE, 'utf8');
    const lines = log.trim().split('\n');
    const last = lines[lines.length - 1] || '';
    assert.ok(last.includes('unit_test_tool'), 'log entry should include tool name');
    assert.ok(!last.includes(secret), 'log entry should never include raw secret');
    assert.ok(last.includes('[REDACTED]'), 'redacted mode should redact sensitive fields');
  } finally {
    await configManager.setValue('toolCallLoggingMode', prevMode ?? 'redacted');
  }
}

async function run() {
  await testCommandValidationFailClosed();
  await testToolCallRedaction();
  console.log('test-security-upgrades: PASS');
}

run().catch((error) => {
  console.error('test-security-upgrades: FAIL', error);
  process.exit(1);
});
