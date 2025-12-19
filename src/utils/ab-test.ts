import { configManager } from '../config-manager.js';

export interface ABTestConfig {
  name: string;           // Test name, used as config key prefix
  variants: string[];     // e.g., ['control', 'treatment'] or ['A', 'B', 'C']
}

export interface ABTestResult {
  variant: string;
  isNewAssignment: boolean;
}

/**
 * Get or create A/B test assignment for current user
 * Assignment is deterministic based on clientId and persisted in config
 */
export async function getABTestVariant(test: ABTestConfig): Promise<ABTestResult> {
  const configKey = `abTest_${test.name}`;
  const existing = await configManager.getValue(configKey);
  
  if (existing !== undefined && test.variants.includes(existing)) {
    return { variant: existing, isNewAssignment: false };
  }
  
  // Assign based on clientId hash
  const clientId = await configManager.getValue('clientId') || '';
  const hash = simpleHash(clientId + test.name);
  const variantIndex = hash % test.variants.length;
  const variant = test.variants[variantIndex];
  
  await configManager.setValue(configKey, variant);
  return { variant, isNewAssignment: true };
}

/**
 * Simple hash function for deterministic assignment
 */
function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

/**
 * Check if user is in treatment group (convenience for 2-variant tests)
 */
export async function isInTreatment(testName: string): Promise<{ inTreatment: boolean; isNew: boolean }> {
  const result = await getABTestVariant({
    name: testName,
    variants: ['noOnboardingPage', 'sawOnboardingPage']
  });
  return { 
    inTreatment: result.variant === 'sawOnboardingPage', 
    isNew: result.isNewAssignment 
  };
}
