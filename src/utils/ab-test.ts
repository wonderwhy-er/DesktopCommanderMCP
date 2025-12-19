import { configManager } from '../config-manager.js';

/**
 * A/B Test controlled feature flags
 * 
 * Usage:
 *   if (await hasFeature('showOnboardingPage')) { ... }
 */

interface Experiment {
  variants: string[];
  // Maps feature name -> which variants enable it
  features: Record<string, string[]>;
}

// Define all active experiments
const experiments: Record<string, Experiment> = {
  'onboardingPage': {
    variants: ['noOnboardingPage', 'showOnboardingPage'],
    features: {
      'showOnboardingPage': ['showOnboardingPage'],
    }
  }
};

// Cache for variant assignments (loaded once per session)
const variantCache: Record<string, string> = {};

/**
 * Get user's variant for an experiment (cached, deterministic)
 */
async function getVariant(experimentName: string): Promise<string | null> {
  const experiment = experiments[experimentName];
  if (!experiment) return null;
  
  // Check cache
  if (variantCache[experimentName]) {
    return variantCache[experimentName];
  }
  
  // Check persisted assignment
  const configKey = `abTest_${experimentName}`;
  const existing = await configManager.getValue(configKey);
  
  if (existing && experiment.variants.includes(existing)) {
    variantCache[experimentName] = existing;
    return existing;
  }
  
  // New assignment based on clientId
  const clientId = await configManager.getValue('clientId') || '';
  const hash = hashCode(clientId + experimentName);
  const variantIndex = hash % experiment.variants.length;
  const variant = experiment.variants[variantIndex];
  
  await configManager.setValue(configKey, variant);
  variantCache[experimentName] = variant;
  return variant;
}

/**
 * Check if a feature is enabled for current user
 */
export async function hasFeature(featureName: string): Promise<boolean> {
  for (const [expName, experiment] of Object.entries(experiments)) {
    const enabledBy = experiment.features[featureName];
    if (enabledBy) {
      const variant = await getVariant(expName);
      return variant !== null && enabledBy.includes(variant);
    }
  }
  return false;
}

/**
 * Get all A/B test assignments for analytics
 */
export async function getABTestAssignments(): Promise<Record<string, string>> {
  const assignments: Record<string, string> = {};
  for (const expName of Object.keys(experiments)) {
    const variant = await getVariant(expName);
    if (variant) {
      assignments[`ab_${expName}`] = variant;
    }
  }
  return assignments;
}

function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}
