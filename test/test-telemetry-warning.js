import assert from 'assert';
import { configManager } from '../dist/config-manager.js';
import { warnIfTelemetryEnvMissing, resetTelemetryWarningForTests } from '../dist/utils/capture.js';

async function run() {
  const prevTelemetryEnabled = await configManager.getValue('telemetryEnabled');

  const originalWrite = process.stderr.write.bind(process.stderr);
  const writes = [];
  process.stderr.write = ((chunk, encoding, cb) => {
    writes.push(String(chunk));
    if (typeof cb === 'function') cb();
    return true;
  });

  try {
    resetTelemetryWarningForTests();
    await configManager.setValue('telemetryEnabled', false);
    await warnIfTelemetryEnvMissing();
    assert.strictEqual(writes.length, 0, 'warning should not be emitted when telemetry is disabled');
  } finally {
    process.stderr.write = originalWrite;
    await configManager.setValue('telemetryEnabled', prevTelemetryEnabled ?? true);
  }

  console.log('test-telemetry-warning: PASS');
}

run().catch((error) => {
  console.error('test-telemetry-warning: FAIL', error);
  process.exit(1);
});
