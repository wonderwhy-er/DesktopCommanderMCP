import assert from 'assert';

import {
  configManager,
  isTelemetryDisabledValue,
  normalizeTelemetryEnabledValue,
} from '../dist/config-manager.js';
import { setConfigValue } from '../dist/tools/config.js';

function testTelemetryHelpers() {
  console.log('\n--- Test: telemetry helper behavior ---');

  assert.strictEqual(normalizeTelemetryEnabledValue('false'), false);
  assert.strictEqual(normalizeTelemetryEnabledValue(' true '), true);
  assert.strictEqual(normalizeTelemetryEnabledValue('disabled'), 'disabled');

  assert.strictEqual(isTelemetryDisabledValue(false), true);
  assert.strictEqual(isTelemetryDisabledValue('false'), true);
  assert.strictEqual(isTelemetryDisabledValue('FALSE'), true);
  assert.strictEqual(isTelemetryDisabledValue(true), false);
  assert.strictEqual(isTelemetryDisabledValue('true'), false);

  console.log('ok: telemetry helpers');
}

async function testConfigManagerCoercion() {
  console.log('\n--- Test: configManager telemetry coercion ---');

  await configManager.updateConfig({ telemetryEnabled: false });
  await configManager.setValue('telemetryEnabled', 'false');

  const telemetryEnabled = await configManager.getValue('telemetryEnabled');
  assert.strictEqual(telemetryEnabled, false);
  assert.strictEqual(typeof telemetryEnabled, 'boolean');

  console.log('ok: configManager coercion');
}

async function testSetConfigValueCoercion() {
  console.log('\n--- Test: set_config_value telemetry coercion ---');

  await configManager.updateConfig({ telemetryEnabled: false });
  const response = await setConfigValue({ key: 'telemetryEnabled', value: 'false' });

  assert.ok(response);
  assert.notStrictEqual(response.isError, true);

  const telemetryEnabled = await configManager.getValue('telemetryEnabled');
  assert.strictEqual(telemetryEnabled, false);
  assert.strictEqual(typeof telemetryEnabled, 'boolean');

  console.log('ok: set_config_value coercion');
}

export default async function runTests() {
  const originalConfig = await configManager.getConfig();

  try {
    testTelemetryHelpers();
    await testConfigManagerCoercion();
    await testSetConfigValueCoercion();

    console.log('\nTelemetry handling tests passed.');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Telemetry handling test failed:', message);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    return false;
  } finally {
    await configManager.updateConfig(originalConfig);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTests()
    .then((success) => {
      process.exit(success ? 0 : 1);
    })
    .catch((error) => {
      console.error('Unhandled error:', error);
      process.exit(1);
    });
}
