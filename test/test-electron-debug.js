#!/usr/bin/env node
import assert from 'assert';

import { cdpAdapter } from '../dist/tools/macos-control/cdp-adapter.js';

async function testDisconnectedCalls() {
  console.log('\n--- Test: electron debug disconnected behavior ---');

  const evalResult = await cdpAdapter.evaluate({
    sessionId: 'missing-session',
    expression: '1 + 1',
  });

  assert.strictEqual(evalResult.ok, false);
  assert.strictEqual(evalResult.error?.code, 'CDP_NOT_CONNECTED');

  const disconnectResult = await cdpAdapter.disconnect('missing-session');
  assert.strictEqual(disconnectResult.ok, false);
  assert.strictEqual(disconnectResult.error?.code, 'CDP_NOT_CONNECTED');

  console.log('✓ electron debug adapter handles missing sessions correctly');
}

async function testAttachFailureShape() {
  console.log('\n--- Test: electron debug attach failure shape ---');

  const attachResult = await cdpAdapter.attach({
    host: '127.0.0.1',
    port: 59999,
  });

  assert.strictEqual(attachResult.ok, false);
  assert.strictEqual(attachResult.error?.code, 'CDP_CONNECT_FAILED');
  assert.ok(attachResult.error?.message);

  console.log('✓ electron debug attach returns typed errors');
}

export default async function runTests() {
  try {
    await testDisconnectedCalls();
    await testAttachFailureShape();
    console.log('\n✅ Electron debug tests passed!');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('❌ test-electron-debug failed:', message);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    return false;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().then((success) => process.exit(success ? 0 : 1));
}
