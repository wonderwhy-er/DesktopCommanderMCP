/**
 * Unit tests for A/B test feature flag system
 * Tests that missing/empty experiments config doesn't break anything
 */

import assert from 'assert';
import {
  MCP_UI_EXPERIMENT_NAME,
  MCP_UI_HIDE_VARIANT,
  MCP_UI_SHOW_VARIANT,
  resolveMcpUiPreviewDecision,
} from '../dist/utils/mcp-ui-ab-test.js';

// Mock the dependencies before importing ab-test
let mockExperiments = {};
let mockConfigValues = {};

// Mock featureFlagManager
const mockFeatureFlagManager = {
  get: (key, defaultValue) => {
    if (key === 'experiments') return mockExperiments;
    return defaultValue;
  }
};

// Mock configManager
const mockConfigManager = {
  getValue: async (key) => mockConfigValues[key],
  setValue: async (key, value) => { mockConfigValues[key] = value; },
  getOrCreateClientId: async () => {
    if (!mockConfigValues.clientId) {
      mockConfigValues.clientId = 'auto-generated-uuid-' + Math.random().toString(36).slice(2);
    }
    return mockConfigValues.clientId;
  }
};

// We need to test the logic directly since we can't easily mock ES modules
// Recreate the core functions with injected dependencies

function getExperiments() {
  return mockFeatureFlagManager.get('experiments', {});
}

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

const variantCache = {};

async function getVariant(experimentName) {
  const experiments = getExperiments();
  const experiment = experiments[experimentName];
  if (!experiment?.variants?.length) return null;
  
  if (variantCache[experimentName]) {
    return variantCache[experimentName];
  }
  
  const configKey = `abTest_${experimentName}`;
  const existing = await mockConfigManager.getValue(configKey);
  
  if (existing && experiment.variants.includes(existing)) {
    variantCache[experimentName] = existing;
    return existing;
  }
  
  const clientId = await mockConfigManager.getOrCreateClientId();
  const hash = hashCode(clientId + experimentName);
  const variantIndex = hash % experiment.variants.length;
  const variant = experiment.variants[variantIndex];
  
  await mockConfigManager.setValue(configKey, variant);
  variantCache[experimentName] = variant;
  return variant;
}

async function hasFeature(featureName) {
  const experiments = getExperiments();
  if (!experiments || typeof experiments !== 'object') return false;
  
  for (const [expName, experiment] of Object.entries(experiments)) {
    if (experiment?.variants?.includes(featureName)) {
      const variant = await getVariant(expName);
      return variant === featureName;
    }
  }
  return false;
}

// Clear state between tests
function resetState() {
  mockExperiments = {};
  mockConfigValues = {};
  Object.keys(variantCache).forEach(k => delete variantCache[k]);
}

function createMcpUiDeps(overrides = {}) {
  const calls = {
    captured: [],
    waitedForFreshFlags: 0,
    variantRequests: [],
  };

  return {
    calls,
    deps: {
      getUserOverride: async () => undefined,
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

// Test runner
async function runTests() {
  let passed = 0;
  let failed = 0;
  
  const test = async (name, fn) => {
    resetState();
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

  console.log('\n🧪 A/B Test Feature Flag Tests\n');

  // Test 1: No experiments at all
  await test('hasFeature returns false when no experiments exist', async () => {
    mockExperiments = {};
    const result = await hasFeature('showOnboardingPage');
    assert.strictEqual(result, false);
  });

  // Test 2: Experiments is undefined/null
  await test('hasFeature returns false when experiments is undefined', async () => {
    mockExperiments = undefined;
    const result = await hasFeature('showOnboardingPage');
    assert.strictEqual(result, false);
  });

  // Test 3: Empty experiments object
  await test('hasFeature returns false with empty experiments object', async () => {
    mockExperiments = {};
    const result = await hasFeature('anyFeature');
    assert.strictEqual(result, false);
  });

  // Test 4: Experiment exists but variants array is empty
  await test('hasFeature returns false when experiment has empty variants', async () => {
    mockExperiments = {
      'TestExp': { variants: [] }
    };
    const result = await hasFeature('showOnboardingPage');
    assert.strictEqual(result, false);
  });

  // Test 5: Experiment exists but variants is undefined
  await test('hasFeature returns false when variants is undefined', async () => {
    mockExperiments = {
      'TestExp': {}
    };
    const result = await hasFeature('showOnboardingPage');
    assert.strictEqual(result, false);
  });

  // Test 6: Feature not in any experiment
  await test('hasFeature returns false for unknown feature', async () => {
    mockExperiments = {
      'OnboardingPreTool': {
        variants: ['noOnboardingPage', 'showOnboardingPage']
      }
    };
    const result = await hasFeature('unknownFeature');
    assert.strictEqual(result, false);
  });

  // Test 7: Feature exists, user assigned to it
  await test('hasFeature returns true when user is assigned to that variant', async () => {
    mockExperiments = {
      'OnboardingPreTool': {
        variants: ['noOnboardingPage', 'showOnboardingPage']
      }
    };
    mockConfigValues = { 'abTest_OnboardingPreTool': 'showOnboardingPage' };
    const result = await hasFeature('showOnboardingPage');
    assert.strictEqual(result, true);
  });

  // Test 8: Feature exists, user assigned to different variant
  await test('hasFeature returns false when user is assigned to different variant', async () => {
    mockExperiments = {
      'OnboardingPreTool': {
        variants: ['noOnboardingPage', 'showOnboardingPage']
      }
    };
    mockConfigValues = { 'abTest_OnboardingPreTool': 'noOnboardingPage' };
    const result = await hasFeature('showOnboardingPage');
    assert.strictEqual(result, false);
  });

  // Test 9: New user gets deterministic assignment
  await test('new user gets deterministic variant assignment based on clientId', async () => {
    mockExperiments = {
      'OnboardingPreTool': {
        variants: ['noOnboardingPage', 'showOnboardingPage']
      }
    };
    mockConfigValues = { clientId: 'test-client-123' };
    
    const result1 = await hasFeature('showOnboardingPage');
    const result2 = await hasFeature('noOnboardingPage');
    
    // One must be true, one must be false
    assert.strictEqual(result1 !== result2, true, 'User should be in exactly one variant');
    
    // Check it was persisted
    const persisted = mockConfigValues['abTest_OnboardingPreTool'];
    assert.ok(persisted, 'Assignment should be persisted to config');
    assert.ok(['noOnboardingPage', 'showOnboardingPage'].includes(persisted));
  });

  // Test 10: Malformed experiment data doesn't crash
  await test('malformed experiment data does not throw', async () => {
    mockExperiments = {
      'BadExp1': null,
      'BadExp2': 'not an object',
      'BadExp3': { variants: 'not an array' },
      'GoodExp': { variants: ['a', 'b'] }
    };
    
    // Should not throw
    const result = await hasFeature('a');
    // Result depends on assignment, but shouldn't crash
    assert.ok(typeof result === 'boolean');
  });

  await test('MCP UI constants match remote experiment contract', async () => {
    assert.strictEqual(MCP_UI_EXPERIMENT_NAME, 'McpUiPreviews');
    assert.strictEqual(MCP_UI_SHOW_VARIANT, 'showMCPUi');
    assert.strictEqual(MCP_UI_HIDE_VARIANT, 'notShowMCPUi');
  });

  await test('MCP UI user override false wins without consulting the experiment', async () => {
    const { deps, calls } = createMcpUiDeps({
      getUserOverride: async () => false,
      getExistingAssignment: async () => MCP_UI_SHOW_VARIANT,
      isFirstRun: () => true,
    });

    const enabled = await resolveMcpUiPreviewDecision(deps);

    assert.strictEqual(enabled, false);
    assert.deepStrictEqual(calls.variantRequests, []);
    assert.deepStrictEqual(calls.captured, []);
  });

  await test('MCP UI user override true wins over a hide assignment', async () => {
    const { deps, calls } = createMcpUiDeps({
      getUserOverride: async () => true,
      getExistingAssignment: async () => MCP_UI_HIDE_VARIANT,
    });

    const enabled = await resolveMcpUiPreviewDecision(deps);

    assert.strictEqual(enabled, true);
    assert.deepStrictEqual(calls.variantRequests, []);
    assert.deepStrictEqual(calls.captured, []);
  });

  await test('MCP UI non-boolean override falls through to the experiment', async () => {
    const { deps, calls } = createMcpUiDeps({
      getUserOverride: async () => 'true', // stringly-typed values must NOT count as an override
      getExistingAssignment: async () => MCP_UI_HIDE_VARIANT,
      isFirstRun: () => false,
      getABTestVariant: async (experimentName) => {
        calls.variantRequests.push(experimentName);
        return MCP_UI_HIDE_VARIANT;
      },
    });

    const enabled = await resolveMcpUiPreviewDecision(deps);

    assert.strictEqual(enabled, false);
    assert.deepStrictEqual(calls.variantRequests, [MCP_UI_EXPERIMENT_NAME]);
  });

  await test('MCP UI existing users without assignment are not enrolled', async () => {
    const { deps, calls } = createMcpUiDeps({ isFirstRun: () => false });

    const enabled = await resolveMcpUiPreviewDecision(deps);

    assert.strictEqual(enabled, true);
    assert.deepStrictEqual(calls.variantRequests, []);
    assert.deepStrictEqual(calls.captured, []);
  });

  await test('MCP UI existing hide assignment can be moved to remote show variant', async () => {
    const { deps, calls } = createMcpUiDeps({
      getExistingAssignment: async () => MCP_UI_HIDE_VARIANT,
      isFirstRun: () => false,
      getABTestVariant: async (experimentName) => {
        calls.variantRequests.push(experimentName);
        return MCP_UI_SHOW_VARIANT;
      },
    });

    const enabled = await resolveMcpUiPreviewDecision(deps);

    assert.strictEqual(enabled, true);
    assert.deepStrictEqual(calls.variantRequests, [MCP_UI_EXPERIMENT_NAME]);
    assert.deepStrictEqual(calls.captured, []);
  });

  await test('MCP UI existing assignment falls back when remote variant is missing', async () => {
    const { deps, calls } = createMcpUiDeps({
      getExistingAssignment: async () => MCP_UI_HIDE_VARIANT,
      isFirstRun: () => false,
    });

    const enabled = await resolveMcpUiPreviewDecision(deps);

    assert.strictEqual(enabled, false);
    assert.deepStrictEqual(calls.variantRequests, [MCP_UI_EXPERIMENT_NAME]);
    assert.deepStrictEqual(calls.captured, []);
  });

  await test('MCP UI first-run show assignment enables UI and captures decision', async () => {
    const { deps, calls } = createMcpUiDeps({
      isFirstRun: () => true,
      wasLoadedFromCache: () => true,
      getABTestVariant: async (experimentName) => {
        calls.variantRequests.push(experimentName);
        return MCP_UI_SHOW_VARIANT;
      },
    });

    const enabled = await resolveMcpUiPreviewDecision(deps);

    assert.strictEqual(enabled, true);
    assert.strictEqual(calls.waitedForFreshFlags, 0);
    assert.deepStrictEqual(calls.variantRequests, [MCP_UI_EXPERIMENT_NAME]);
    assert.strictEqual(calls.captured.length, 1);
    assert.strictEqual(calls.captured[0].event, 'server_mcp_ui_ab_decision');
    assert.strictEqual(calls.captured[0].properties.experiment, MCP_UI_EXPERIMENT_NAME);
    assert.strictEqual(calls.captured[0].properties.variant, MCP_UI_SHOW_VARIANT);
    assert.strictEqual(calls.captured[0].properties.mcp_ui_enabled, true);
  });

  await test('MCP UI first-run unknown variant defaults enabled without capture', async () => {
    const { deps, calls } = createMcpUiDeps({
      isFirstRun: () => true,
      getABTestVariant: async (experimentName) => {
        calls.variantRequests.push(experimentName);
        return 'unknownVariant';
      },
    });

    const enabled = await resolveMcpUiPreviewDecision(deps);

    assert.strictEqual(enabled, true);
    assert.deepStrictEqual(calls.variantRequests, [MCP_UI_EXPERIMENT_NAME]);
    assert.deepStrictEqual(calls.captured, []);
  });

  await test('MCP UI first-run hide assignment disables UI after fresh flag wait', async () => {
    const { deps, calls } = createMcpUiDeps({
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
    assert.deepStrictEqual(calls.variantRequests, [MCP_UI_EXPERIMENT_NAME]);
    assert.strictEqual(calls.captured.length, 1);
    assert.strictEqual(calls.captured[0].properties.variant, MCP_UI_HIDE_VARIANT);
    assert.strictEqual(calls.captured[0].properties.mcp_ui_enabled, false);
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
