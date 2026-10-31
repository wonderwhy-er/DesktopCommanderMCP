/**
 * Unit tests for A/B test feature flag system
 * Tests that missing/empty experiments config doesn't break anything
 *
 * Tests 1-11 run the real ab-test module (dist/utils/ab-test.js) in a fresh
 * process per scenario: the experiments go into the feature-flag cache and
 * assignments into config.json under a temporary HOME, exactly where the
 * product reads them. The MCP UI tests call resolveMcpUiPreviewDecision with
 * injected dependencies.
 */

import assert from 'assert';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import {
  MCP_UI_EXPERIMENT_NAME,
  MCP_UI_HIDE_VARIANT,
  MCP_UI_SHOW_VARIANT,
  resolveMcpUiPreviewDecision,
} from '../dist/utils/mcp-ui-ab-test.js';
import { runIfMain } from './helpers/run-if-main.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distModule = (file) => pathToFileURL(path.join(__dirname, '..', 'dist', ...file.split('/'))).href;

// Weighted variants, the format the product reads (v2 feature flags)
const ONBOARDING_EXPERIMENT = {
  OnboardingPreTool: {
    variants: [
      { name: 'noOnboardingPage', weight: 50 },
      { name: 'showOnboardingPage', weight: 50 },
    ],
  },
};

const CHILD_SCRIPT = `
import fs from 'fs';
import os from 'os';
import path from 'path';
const dir = path.join(os.homedir(), '.claude-server-commander');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'feature-flags.json'), JSON.stringify({ version: '1', flags: JSON.parse(process.env.FLAGS) }));
fs.writeFileSync(path.join(dir, 'config.json'), process.env.CONFIG);
const { featureFlagManager } = await import(process.env.FLAGS_MODULE);
await featureFlagManager.initialize();
const { hasFeature } = await import(process.env.AB_MODULE);
const { configManager } = await import(process.env.CONFIG_MODULE);
const result = { features: {} };
try {
  for (const name of JSON.parse(process.env.FEATURES)) result.features[name] = await hasFeature(name);
} catch (error) {
  result.error = error.message;
}
result.config = await configManager.getConfig();
console.log('RESULT ' + JSON.stringify(result));
process.exit(0);
`;

/**
 * Put `experiments` into the feature flags and `config` into config.json, then ask the
 * real hasFeature() about each name in `features`. Returns the answers and the final config.
 */
async function runAbTest({ experiments, config = {}, features }) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dc-abtest-home-'));
  try {
    const flags = experiments === undefined ? {} : { experiments };
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD_SCRIPT], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        DC_FLAG_URL: 'http://127.0.0.1:9/flags.json',
        DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1',
        FLAGS_MODULE: distModule('utils/feature-flags.js'),
        AB_MODULE: distModule('utils/ab-test.js'),
        CONFIG_MODULE: distModule('config-manager.js'),
        FLAGS: JSON.stringify(flags),
        CONFIG: JSON.stringify({ telemetryEnabled: false, welcomeOnboardingEligible: false, pendingWelcomeOnboarding: false, ...config }),
        FEATURES: JSON.stringify(features),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve) => child.on('close', resolve));
    const line = stdout.split('\n').find((l) => l.startsWith('RESULT '));
    assert(line, `ab-test process failed (exit ${code}): ${stderr || stdout}`);
    return JSON.parse(line.slice('RESULT '.length));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
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
    const { features, error } = await runAbTest({ experiments: undefined, features: ['showOnboardingPage'] });
    assert.strictEqual(error, undefined);
    assert.strictEqual(features.showOnboardingPage, false);
  });

  // Test 2: Experiments is null
  await test('hasFeature returns false when experiments is null', async () => {
    const { features, error } = await runAbTest({ experiments: null, features: ['showOnboardingPage'] });
    assert.strictEqual(error, undefined);
    assert.strictEqual(features.showOnboardingPage, false);
  });

  // Test 3: Empty experiments object
  await test('hasFeature returns false with empty experiments object', async () => {
    const { features, error } = await runAbTest({ experiments: {}, features: ['anyFeature'] });
    assert.strictEqual(error, undefined);
    assert.strictEqual(features.anyFeature, false);
  });

  // Test 4: Experiment exists but variants array is empty
  await test('hasFeature returns false when experiment has empty variants', async () => {
    const { features, error } = await runAbTest({ experiments: { TestExp: { variants: [] } }, features: ['showOnboardingPage'] });
    assert.strictEqual(error, undefined);
    assert.strictEqual(features.showOnboardingPage, false);
  });

  // Test 5: Experiment exists but variants is undefined
  await test('hasFeature returns false when variants is undefined', async () => {
    const { features, error } = await runAbTest({ experiments: { TestExp: {} }, features: ['showOnboardingPage'] });
    assert.strictEqual(error, undefined);
    assert.strictEqual(features.showOnboardingPage, false);
  });

  // Test 6: Feature not in any experiment
  await test('hasFeature returns false for unknown feature', async () => {
    const { features, error } = await runAbTest({ experiments: ONBOARDING_EXPERIMENT, features: ['unknownFeature'] });
    assert.strictEqual(error, undefined);
    assert.strictEqual(features.unknownFeature, false);
  });

  // Test 7: Feature exists, user assigned to it
  await test('hasFeature returns true when user is assigned to that variant', async () => {
    const { features, error } = await runAbTest({
      experiments: ONBOARDING_EXPERIMENT,
      config: { abTest_OnboardingPreTool: 'showOnboardingPage' },
      features: ['showOnboardingPage'],
    });
    assert.strictEqual(error, undefined);
    assert.strictEqual(features.showOnboardingPage, true);
  });

  // Test 8: Feature exists, user assigned to different variant
  await test('hasFeature returns false when user is assigned to different variant', async () => {
    const { features, error } = await runAbTest({
      experiments: ONBOARDING_EXPERIMENT,
      config: { abTest_OnboardingPreTool: 'noOnboardingPage' },
      features: ['showOnboardingPage'],
    });
    assert.strictEqual(error, undefined);
    assert.strictEqual(features.showOnboardingPage, false);
  });

  // Test 9: New user gets deterministic assignment
  await test('new user gets deterministic variant assignment based on clientId', async () => {
    const scenario = {
      experiments: ONBOARDING_EXPERIMENT,
      config: { clientId: 'test-client-123' },
      features: ['showOnboardingPage', 'noOnboardingPage'],
    };
    const first = await runAbTest(scenario);
    const second = await runAbTest(scenario);
    assert.strictEqual(first.error, undefined);

    // One must be true, one must be false
    assert.strictEqual(first.features.showOnboardingPage !== first.features.noOnboardingPage, true, 'User should be in exactly one variant');

    // Check it was persisted, and the same clientId always gets the same variant
    const persisted = first.config.abTest_OnboardingPreTool;
    assert.ok(['noOnboardingPage', 'showOnboardingPage'].includes(persisted), 'Assignment should be persisted to config');
    assert.strictEqual(second.config.abTest_OnboardingPreTool, persisted, 'Same clientId should get the same variant');
  });

  // Test 10: Malformed experiment data doesn't crash, and the valid experiment next to it still answers
  await test('malformed experiment data does not throw', async () => {
    const { features, error } = await runAbTest({
      experiments: {
        BadExp1: null,
        BadExp2: 'not an object',
        BadExp3: { variants: 'not an array' },
        GoodExp: { variants: [{ name: 'a', weight: 50 }, { name: 'b', weight: 50 }] },
      },
      config: { abTest_GoodExp: 'a' },
      features: ['a'],
    });
    assert.strictEqual(error, undefined, 'hasFeature should not throw on malformed experiments');
    assert.strictEqual(features.a, true, 'The valid experiment next to the malformed ones should still answer');
  });

  // Test 11: An experiment name is a plain key, even one an object treats specially.
  // JSON.parse makes "__proto__" an own key, as it is in the flags the product reads.
  await test('an experiment named __proto__ answers like any other', async () => {
    const { features, error } = await runAbTest({
      experiments: JSON.parse('{"__proto__": {"variants": [{"name": "protoA", "weight": 50}, {"name": "protoB", "weight": 50}]}}'),
      config: { abTest___proto__: 'protoA' },
      features: ['protoA', 'protoB'],
    });
    assert.strictEqual(error, undefined);
    assert.deepStrictEqual(features, { protoA: true, protoB: false }, 'The assigned variant of an experiment named __proto__ should be on');
  });


  await test('MCP UI constants match remote experiment contract', async () => {
    assert.strictEqual(MCP_UI_EXPERIMENT_NAME, 'McpUiPreviews');
    assert.strictEqual(MCP_UI_SHOW_VARIANT, 'showMCPUi');
    assert.strictEqual(MCP_UI_HIDE_VARIANT, 'notShowMCPUi');
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

runIfMain(import.meta.url, runTests);
