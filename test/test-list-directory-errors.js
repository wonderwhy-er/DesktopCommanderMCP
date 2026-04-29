import assert from 'assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { configManager } from '../dist/config-manager.js';
import { listDirectory } from '../dist/tools/filesystem.js';

const TEST_ROOT_PREFIX = path.join(os.tmpdir(), 'desktop-commander-list-directory-errors-');

async function setup() {
  const originalConfig = await configManager.getConfig();
  const testRoot = await fs.mkdtemp(TEST_ROOT_PREFIX);
  await configManager.setValue('allowedDirectories', [testRoot]);
  return { originalConfig, testRoot };
}

async function teardown(originalConfig, testRoot) {
  await configManager.updateConfig(originalConfig);
  await fs.rm(testRoot, { recursive: true, force: true });
}

async function testMissingDirectoryReturnsNotFound(testRoot) {
  const missingDir = path.join(testRoot, 'missing-dir');

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
  let testRoot;
  try {
    ({ originalConfig, testRoot } = await setup());
    await testMissingDirectoryReturnsNotFound(testRoot);
    console.log('\n✅ list_directory error tests passed!');
    return true;
  } catch (error) {
    console.error('❌ list_directory error test failed:', error instanceof Error ? error.message : String(error));
    return false;
  } finally {
    if (originalConfig && testRoot) {
      await teardown(originalConfig, testRoot);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().then((ok) => {
    process.exit(ok ? 0 : 1);
  });
}
