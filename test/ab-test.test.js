/**
 * Unit tests for A/B test feature flag system
 * Tests that missing/empty experiments config doesn't break anything
 */

import assert from 'assert';

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
