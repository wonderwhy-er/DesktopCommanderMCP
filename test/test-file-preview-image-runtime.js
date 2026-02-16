import assert from 'assert';

import {
  isAllowedImageMimeType,
  normalizeImageMimeType
} from '../dist/ui/file-preview/src/image-preview.js';

async function testAllowedImageMimeTypes() {
  console.log('\n--- Test: image preview allowlist ---');

  assert.strictEqual(isAllowedImageMimeType('image/png'), true, 'PNG should be allowlisted');
  assert.strictEqual(isAllowedImageMimeType('image/jpeg'), true, 'JPEG should be allowlisted');
  assert.strictEqual(isAllowedImageMimeType('image/gif'), true, 'GIF should be allowlisted');
  assert.strictEqual(isAllowedImageMimeType('image/webp'), true, 'WEBP should be allowlisted');
  assert.strictEqual(isAllowedImageMimeType('image/bmp'), true, 'BMP should be allowlisted');
  assert.strictEqual(isAllowedImageMimeType('image/svg+xml'), true, 'SVG should be allowlisted');
  assert.strictEqual(isAllowedImageMimeType('image/svg'), true, 'Non-standard SVG MIME should be treated as allowlisted');

  assert.strictEqual(isAllowedImageMimeType('IMAGE/PNG; charset=utf-8'), true, 'MIME normalization should keep allowlisted types valid');
  console.log('✓ image allowlist accepts expected MIME types');
}

async function testDisallowedImageMimeTypes() {
  console.log('\n--- Test: disallowed image MIME types ---');

  assert.strictEqual(isAllowedImageMimeType('image/tiff'), false, 'TIFF should be blocked');
  assert.strictEqual(isAllowedImageMimeType('text/plain'), false, 'Non-image MIME should be blocked');
  assert.strictEqual(isAllowedImageMimeType(undefined), false, 'Undefined MIME should be blocked');
  assert.strictEqual(isAllowedImageMimeType(''), false, 'Empty MIME should be blocked');
  console.log('✓ disallowed MIME types fail closed');
}

async function testMimeNormalization() {
  console.log('\n--- Test: MIME normalization ---');

  assert.strictEqual(normalizeImageMimeType('IMAGE/JPEG; charset=UTF-8'), 'image/jpeg', 'Normalization should lowercase and strip parameters');
  assert.strictEqual(normalizeImageMimeType(' image/webp '), 'image/webp', 'Normalization should trim whitespace');
  assert.strictEqual(normalizeImageMimeType(undefined), '', 'Normalization should return empty string for undefined input');
  console.log('✓ MIME normalization is stable');
}

export default async function runTests() {
  try {
    await testAllowedImageMimeTypes();
    await testDisallowedImageMimeTypes();
    await testMimeNormalization();
    console.log('\n✅ File preview image runtime tests passed!');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('❌ Test failed:', message);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    return false;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().then((success) => {
    process.exit(success ? 0 : 1);
  }).catch((error) => {
    console.error('❌ Unhandled error:', error);
    process.exit(1);
  });
}
