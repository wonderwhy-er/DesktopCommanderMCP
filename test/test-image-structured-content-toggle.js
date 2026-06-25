/**
 * Test: DC_NO_IMAGE_STRUCTURED_BASE64 env var toggles whether the image base64
 * is duplicated into structuredContent for read_file image responses.
 *
 * The content[image] block stays present in all cases so the host model can
 * see the image natively. See #521.
 */

import { configManager } from '../dist/config-manager.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { handleReadFile } from '../dist/handlers/filesystem-handlers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_DIR = path.join(__dirname, 'test_image_structured_content_toggle');
const IMAGE_FILE = path.join(TEST_DIR, 'tiny.png');
// 1x1 transparent PNG, used in other handler tests as well.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6p6xkAAAAASUVORK5CYII=';

async function cleanupTestDirectory() {
  try {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Error during cleanup:', error);
    }
  }
}

async function setup() {
  await cleanupTestDirectory();
  await fs.mkdir(TEST_DIR, { recursive: true });
  await fs.writeFile(IMAGE_FILE, Buffer.from(TINY_PNG_BASE64, 'base64'));

  const originalConfig = await configManager.getConfig();
  await configManager.setValue('allowedDirectories', [TEST_DIR]);
  return originalConfig;
}

async function teardown(originalConfig) {
  try {
    await cleanupTestDirectory();
  } catch (error) {
    console.error('Warning: cleanup failed:', error?.message ?? error);
  }
  if (originalConfig) {
    try {
      await configManager.updateConfig(originalConfig);
    } catch (error) {
      console.error('Warning: config restore failed:', error?.message ?? error);
    }
  }
}

function captureEnv(name) {
  const previous = process.env[name];
  return () => {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  };
}

async function testDefaultIncludesBase64InStructuredContent() {
  console.log('\n--- Test: default keeps image base64 in structuredContent ---');
  const restoreEnv = captureEnv('DC_NO_IMAGE_STRUCTURED_BASE64');
  delete process.env.DC_NO_IMAGE_STRUCTURED_BASE64;
  try {
    const result = await handleReadFile({ path: IMAGE_FILE });
    assert.ok(result.structuredContent, 'structuredContent should exist');
    assert.strictEqual(
      typeof result.structuredContent.content,
      'string',
      'structuredContent.content should be a string by default'
    );
    assert.ok(
      result.structuredContent.content.length > 0,
      'structuredContent.content should be non-empty by default'
    );
    assert.strictEqual(
      typeof result.structuredContent.imageData,
      'string',
      'structuredContent.imageData should be a string by default'
    );
    assert.strictEqual(
      result.structuredContent.content,
      result.structuredContent.imageData,
      'structuredContent.content and imageData should match by default'
    );
    console.log('✓ default behavior carries image base64 in structuredContent');
  } finally {
    restoreEnv();
  }
}

async function testOptInOmitsBase64FromStructuredContent() {
  console.log('\n--- Test: DC_NO_IMAGE_STRUCTURED_BASE64=true omits image base64 ---');
  const restoreEnv = captureEnv('DC_NO_IMAGE_STRUCTURED_BASE64');
  process.env.DC_NO_IMAGE_STRUCTURED_BASE64 = 'true';
  try {
    const result = await handleReadFile({ path: IMAGE_FILE });
    assert.ok(result.structuredContent, 'structuredContent should still exist');
    assert.strictEqual(
      result.structuredContent.content,
      undefined,
      'structuredContent.content should be omitted when opt-in is set'
    );
    assert.strictEqual(
      result.structuredContent.imageData,
      undefined,
      'structuredContent.imageData should be omitted when opt-in is set'
    );

    const imageBlock = result.content.find((item) => item.type === 'image');
    assert.ok(
      imageBlock,
      'content[] should still include the image block so the model can see the image'
    );
    assert.ok(
      typeof imageBlock.data === 'string' && imageBlock.data.length > 0,
      'image block should carry non-empty base64 data'
    );
    assert.strictEqual(
      imageBlock.mimeType,
      'image/png',
      'image block should carry the png mimeType'
    );

    assert.strictEqual(
      result.structuredContent.fileType,
      'image',
      'structuredContent.fileType should remain "image"'
    );
    assert.strictEqual(
      result.structuredContent.mimeType,
      'image/png',
      'structuredContent.mimeType should remain present'
    );
    assert.strictEqual(
      result.structuredContent.filePath,
      IMAGE_FILE,
      'structuredContent.filePath should remain present'
    );
    assert.strictEqual(
      result.structuredContent.sourceTool,
      'read_file',
      'structuredContent.sourceTool should remain present'
    );
    console.log(
      '✓ opt-in omits image base64 from structuredContent while keeping content[image] and metadata'
    );
  } finally {
    restoreEnv();
  }
}

async function testNonTrueValuesKeepBase64() {
  console.log('\n--- Test: only the literal string "true" enables the opt-in ---');
  const restoreEnv = captureEnv('DC_NO_IMAGE_STRUCTURED_BASE64');
  try {
    for (const value of ['1', 'yes', 'TRUE', 'false', '']) {
      process.env.DC_NO_IMAGE_STRUCTURED_BASE64 = value;
      const result = await handleReadFile({ path: IMAGE_FILE });
      assert.strictEqual(
        typeof result.structuredContent.content,
        'string',
        `value=${JSON.stringify(value)}: structuredContent.content should still be present (only the literal "true" opts in)`
      );
    }
    console.log('✓ only the literal string "true" enables the opt-in');
  } finally {
    restoreEnv();
  }
}

export default async function runTests() {
  let originalConfig;
  try {
    originalConfig = await setup();
    await testDefaultIncludesBase64InStructuredContent();
    await testOptInOmitsBase64FromStructuredContent();
    await testNonTrueValuesKeepBase64();
    console.log('\n✅ Image structuredContent toggle tests passed!');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('❌ Test failed:', message);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    return false;
  } finally {
    await teardown(originalConfig);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTests()
    .then((success) => {
      process.exit(success ? 0 : 1);
    })
    .catch((error) => {
      console.error('❌ Unhandled error:', error);
      process.exit(1);
    });
}
