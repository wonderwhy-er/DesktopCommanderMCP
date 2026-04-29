import assert from 'assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { configManager } from '../dist/config-manager.js';
import { listDirectory } from '../dist/tools/filesystem.js';

const TEST_ROOT = path.join(os.tmpdir(), 'desktop-commander-list-directory-errors');

async function setup() {
  const originalConfig = await configManager.getConfig();
  await fs.mkdir(TEST_ROOT, { recursive: true });
  await configManager.setValue('allowedDirectories', [TEST_ROOT]);
  return originalConfig;
}

async function teardown(originalConfig) {
  await configManager.updateConfig(originalConfig);
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
}

async function testMissingDirectoryReturnsNotFound() {
  const missingDir = path.join(TEST_ROOT, 'missing-dir');

  await assert.rejects(
    listDirectory(missingDir, 1),
    (error) => {
      assert(error instanceof Error);
      assert(error.message.includes(`Directory not found: ${missingDir}`));
      assert(!error.message.includes('[DENIED]'));
      return true;
    },
    'Missing directories should raise a not-found error instead of returning [DENIED]',
  );

  console.log('✓ missing directory returns not-found error');
}

export default async function runTests() {
  let originalConfig;
  try {
    originalConfig = await setup();
    await testMissingDirectoryReturnsNotFound();
    console.log('\n✅ list_directory error tests passed!');
    return true;
  } catch (error) {
    console.error('❌ list_directory error test failed:', error instanceof Error ? error.message : String(error));
    return false;
  } finally {
    if (originalConfig) {
      await teardown(originalConfig);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().then((ok) => {
    process.exit(ok ? 0 : 1);
  });
}
