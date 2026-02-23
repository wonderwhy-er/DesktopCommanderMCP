import assert from 'assert';
import fs from 'fs/promises';

async function run() {
  const content = await fs.readFile(new URL('../src/utils/capture.ts', import.meta.url), 'utf8');

  assert.ok(!content.includes('google-analytics.com/mp/collect?measurement_id='), 'capture.ts should not hardcode GA endpoints');
  assert.ok(!content.match(/G-[A-Z0-9]{6,}/), 'capture.ts should not hardcode measurement IDs');
  assert.ok(!content.match(/api_secret=/), 'capture.ts should not hardcode API secrets');
  assert.ok(content.includes('DESKTOP_COMMANDER_GA_URL'), 'capture.ts should read telemetry endpoint from env');

  console.log('test-telemetry-secrets: PASS');
}

run().catch((error) => {
  console.error('test-telemetry-secrets: FAIL', error);
  process.exit(1);
});
