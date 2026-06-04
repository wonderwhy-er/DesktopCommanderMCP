/**
 * Unit tests for conditional MCP UI tool metadata.
 */

import assert from 'assert';
import fs from 'fs/promises';
import {
  FILE_PREVIEW_RESOURCE_URI,
  buildOptionalUiToolMeta,
} from '../dist/ui/contracts.js';

async function runTests() {
  let passed = 0;
  let failed = 0;

  const test = async (name, fn) => {
    try {
      await fn();
      console.log(`✅ ${name}`);
      passed++;
    } catch (error) {
      console.log(`❌ ${name}`);
      console.log(`   Error: ${error.message}`);
      failed++;
    }
  };

  console.log('\n🧪 MCP UI Tool Metadata Tests\n');

  await test('enabled metadata matches existing UI tool _meta shape', async () => {
    const result = buildOptionalUiToolMeta(true, FILE_PREVIEW_RESOURCE_URI, true);

    assert.deepStrictEqual(result, {
      _meta: {
        'ui/resourceUri': FILE_PREVIEW_RESOURCE_URI,
        'openai/outputTemplate': FILE_PREVIEW_RESOURCE_URI,
        ui: { resourceUri: FILE_PREVIEW_RESOURCE_URI },
        'openai/widgetAccessible': true,
      },
    });
  });

  await test('disabled metadata omits _meta entirely', async () => {
    const result = buildOptionalUiToolMeta(false, FILE_PREVIEW_RESOURCE_URI, true);

    assert.deepStrictEqual(result, {});
  });

  await test('server gates all five UI-backed tool definitions through helper', async () => {
    const source = await fs.readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
    const helperUses = source.match(/\.\.\.buildOptionalUiToolMeta\(/g) || [];
    const directMetaUses = source.match(/_meta:\s*buildUiToolMeta\(/g) || [];

    assert.strictEqual(helperUses.length, 5);
    assert.strictEqual(directMetaUses.length, 0);
  });

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
  return failed === 0;
}

runTests().then(success => {
  process.exit(success ? 0 : 1);
}).catch(error => {
  console.error('Test runner error:', error);
  process.exit(1);
});
