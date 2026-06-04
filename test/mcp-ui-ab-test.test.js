/**
 * Unit tests for MCP UI preview A/B decision logic.
 */

import assert from 'assert';
import {
  MCP_UI_EXPERIMENT_NAME,
  MCP_UI_HIDE_VARIANT,
  MCP_UI_SHOW_VARIANT,
  resolveMcpUiPreviewDecision,
} from '../dist/utils/mcp-ui-ab-test.js';

function createDeps(overrides = {}) {
  const calls = {
    captured: [],
    waitedForFreshFlags: 0,
    variantRequests: [],
  };

  return {
    calls,
    deps: {
      getExistingAssignment: async () => undefined,
      isFirstRun: () => false,
      wasLoadedFromCache: () => true,
      waitForFreshFlags: async () => { calls.waitedForFreshFlags++; },
      getABTestVariant: async (experimentName) => {
        calls.variantRequests.push(experimentName);
        return null;
      },
      capture: async (event, properties) => {
        calls.captured.push({ event, properties });
      },
      ...overrides,
    },
  };
}

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

  console.log('\n🧪 MCP UI A/B Test Decision Tests\n');

  await test('exports the agreed experiment constants', async () => {
    assert.strictEqual(MCP_UI_EXPERIMENT_NAME, 'McpUiPreviews');
    assert.strictEqual(MCP_UI_SHOW_VARIANT, 'showMCPui');
    assert.strictEqual(MCP_UI_HIDE_VARIANT, 'notSHowMcpui');
  });

  await test('existing user without assignment defaults enabled and is not enrolled', async () => {
    const { deps, calls } = createDeps({ isFirstRun: () => false });

    const enabled = await resolveMcpUiPreviewDecision(deps);

    assert.strictEqual(enabled, true);
    assert.deepStrictEqual(calls.variantRequests, []);
    assert.deepStrictEqual(calls.captured, []);
  });

  await test('persisted hide assignment is honored', async () => {
    const { deps, calls } = createDeps({
      getExistingAssignment: async () => MCP_UI_HIDE_VARIANT,
      isFirstRun: () => false,
    });

    const enabled = await resolveMcpUiPreviewDecision(deps);

    assert.strictEqual(enabled, false);
    assert.deepStrictEqual(calls.variantRequests, []);
  });

  await test('first-run show assignment enables UI and captures decision', async () => {
    const { deps, calls } = createDeps({
      isFirstRun: () => true,
      getABTestVariant: async (experimentName) => {
        calls.variantRequests.push(experimentName);
        return MCP_UI_SHOW_VARIANT;
      },
    });

    const enabled = await resolveMcpUiPreviewDecision(deps);

    assert.strictEqual(enabled, true);
    assert.deepStrictEqual(calls.variantRequests, [MCP_UI_EXPERIMENT_NAME]);
    assert.strictEqual(calls.captured.length, 1);
    assert.strictEqual(calls.captured[0].event, 'server_mcp_ui_ab_decision');
    assert.strictEqual(calls.captured[0].properties.variant, MCP_UI_SHOW_VARIANT);
    assert.strictEqual(calls.captured[0].properties.mcp_ui_enabled, true);
  });

  await test('first-run hide assignment disables UI and captures decision', async () => {
    const { deps, calls } = createDeps({
      isFirstRun: () => true,
      wasLoadedFromCache: () => false,
      getABTestVariant: async (experimentName) => {
        calls.variantRequests.push(experimentName);
        return MCP_UI_HIDE_VARIANT;
      },
    });

    const enabled = await resolveMcpUiPreviewDecision(deps);

    assert.strictEqual(enabled, false);
    assert.strictEqual(calls.waitedForFreshFlags, 1);
    assert.strictEqual(calls.captured.length, 1);
    assert.strictEqual(calls.captured[0].properties.variant, MCP_UI_HIDE_VARIANT);
    assert.strictEqual(calls.captured[0].properties.mcp_ui_enabled, false);
  });

  await test('capture failure does not override first-run hide assignment', async () => {
    const { deps } = createDeps({
      isFirstRun: () => true,
      getABTestVariant: async () => MCP_UI_HIDE_VARIANT,
      capture: async () => { throw new Error('telemetry unavailable'); },
    });

    const enabled = await resolveMcpUiPreviewDecision(deps);

    assert.strictEqual(enabled, false);
  });

  await test('missing experiment defaults enabled without capture', async () => {
    const { deps, calls } = createDeps({ isFirstRun: () => true });

    const enabled = await resolveMcpUiPreviewDecision(deps);

    assert.strictEqual(enabled, true);
    assert.deepStrictEqual(calls.captured, []);
  });

  await test('decision errors default enabled', async () => {
    const { deps } = createDeps({
      getExistingAssignment: async () => { throw new Error('config unavailable'); },
    });

    const enabled = await resolveMcpUiPreviewDecision(deps);

    assert.strictEqual(enabled, true);
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
