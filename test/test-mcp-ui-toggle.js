/**
 * Unit tests for the MCP UI user toggle (showMcpUI config override).
 * UI widgets are shown by default; only an explicit boolean opts in/out.
 */

import assert from 'assert';
import { mcpUiEnabledFor } from '../dist/utils/mcp-ui.js';

async function runTests() {
  let passed = 0;
  let failed = 0;

  const test = async (name, fn) => {
    try {
      await fn();
      console.log(`✅ ${name}`);
      passed++;
    } catch (e) {
      console.log(`❌ ${name}`);
      console.log(`   Error: ${e.message}`);
      failed++;
    }
  };

  console.log('\n🧪 MCP UI Toggle Tests\n');

  await test('explicit false hides MCP UI', async () => {
    assert.strictEqual(mcpUiEnabledFor(false), false);
  });

  await test('explicit true shows MCP UI', async () => {
    assert.strictEqual(mcpUiEnabledFor(true), true);
  });

  await test('unset value defaults to shown', async () => {
    assert.strictEqual(mcpUiEnabledFor(undefined), true);
  });

  await test('non-boolean values do not count as an override', async () => {
    // Stringly-typed or malformed config must not hide the UI.
    assert.strictEqual(mcpUiEnabledFor('false'), true);
    assert.strictEqual(mcpUiEnabledFor('true'), true);
    assert.strictEqual(mcpUiEnabledFor(null), true);
    assert.strictEqual(mcpUiEnabledFor(0), true);
    assert.strictEqual(mcpUiEnabledFor({}), true);
  });

  // Summary
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);

  return failed === 0;
}

// Run tests
runTests().then(success => {
  process.exit(success ? 0 : 1);
}).catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
