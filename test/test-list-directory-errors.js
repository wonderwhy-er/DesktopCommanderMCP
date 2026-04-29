import assert from 'assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { configManager } from '../dist/config-manager.js';
import { listDirectory } from '../dist/tools/filesystem.js';

const TEST_ROOT_PREFIX = path.join(os.tmpdir(), 'desktop-commander-list-directory-errors-');

async function setup() {
  const originalConfig = await configManager.getConfig();
  const testRoot = await fs.realpath(await fs.mkdtemp(TEST_ROOT_PREFIX));
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

async function testTopLevelStatAccessDeniedReturnsDeniedEntry(testRoot) {
  const deniedDir = path.join(testRoot, 'stat-denied');
  await fs.mkdir(deniedDir);

  const originalStat = fs.stat;
  fs.stat = async (target, ...args) => {
    if (path.resolve(String(target)) === deniedDir) {
      const error = new Error(`EACCES: permission denied, stat '${deniedDir}'`);
      error.code = 'EACCES';
      throw error;
    }
    return originalStat.call(fs, target, ...args);
  };

  try {
    const entries = await listDirectory(deniedDir, 1);
    assert.strictEqual(entries.length, 1);
    assert(entries[0].startsWith('[DENIED] stat-denied'), 'Top-level stat access errors should keep [DENIED] output');
    assert(entries[0].includes('not accessible'), 'Permission-like stat errors should include the access hint');
    console.log('✓ top-level stat access error returns denied entry');
  } finally {
    fs.stat = originalStat;
  }
}

export default async function runTests() {
  let originalConfig;
  let testRoot;
  try {
    ({ originalConfig, testRoot } = await setup());
    await testMissingDirectoryReturnsNotFound(testRoot);
    await testTopLevelStatAccessDeniedReturnsDeniedEntry(testRoot);
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
