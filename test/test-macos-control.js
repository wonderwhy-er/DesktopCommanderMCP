#!/usr/bin/env node
import assert from 'assert';

import {
  MacosAxFindArgsSchema,
  MacosAxClickArgsSchema,
  MacosAxBatchArgsSchema,
} from '../dist/tools/schemas.js';
import { macosControlOrchestrator } from '../dist/tools/macos-control/orchestrator.js';

async function testSchemas() {
  console.log('\n--- Test: macOS control schemas ---');

  const findParsed = MacosAxFindArgsSchema.parse({
    app: 'System Settings',
    text: 'Bluetooth',
    role: 'toggle',
  });
  assert.strictEqual(findParsed.app, 'System Settings');

  const clickById = MacosAxClickArgsSchema.parse({ id: '123-abc' });
  assert.strictEqual(clickById.id, '123-abc');

  const clickByText = MacosAxClickArgsSchema.parse({ app: 'Finder', text: 'Downloads' });
  assert.strictEqual(clickByText.app, 'Finder');

  const batchParsed = MacosAxBatchArgsSchema.parse({
    commands: [
      { action: 'wait', ms: 250 },
      { action: 'activate', app: 'Finder' }
    ]
  });
  assert.strictEqual(batchParsed.commands.length, 2);
  assert.strictEqual(batchParsed.stopOnError, true);

  console.log('✓ macOS control schemas parse correctly');
}

async function testPlatformGating() {
  console.log('\n--- Test: macOS control platform gating ---');

  if (process.platform !== 'darwin') {
    const batchResult = await macosControlOrchestrator.axBatch([
      { action: 'wait', ms: 100 }
    ]);

    assert.strictEqual(batchResult.ok, false);
    assert.strictEqual(batchResult.error?.code, 'UNSUPPORTED_PLATFORM');
    console.log('✓ non-macOS gating works');
    return;
  }

  const statusResult = await macosControlOrchestrator.axStatus();
  assert.ok(typeof statusResult.ok === 'boolean');
  console.log('✓ macOS status call executed');
}

export default async function runTests() {
  try {
    await testSchemas();
    await testPlatformGating();
    console.log('\n✅ macOS control tests passed!');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('❌ test-macos-control failed:', message);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    return false;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().then((success) => process.exit(success ? 0 : 1));
}
