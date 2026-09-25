import { configManager } from '../config-manager.js';
import { featureFlagManager } from './feature-flags.js';

/**
 * A/B Test controlled feature flags
 * 
 * Experiments are defined in remote feature flags JSON (v2 format with weights):
 * {
 *   "flags": {
 *     "experiments": {
 *       "OnboardingPreTool": {
 *         "variants": [
 *           { "name": "noOnboardingPage", "weight": 20 },
 *           { "name": "showOnboardingPage", "weight": 80 }
 *         ]
 *       }
 *     }
 *   }
 * }
 * 
 * Usage:
 *   if (await hasFeature('showOnboardingPage')) { ... }
 */

interface WeightedVariant {
  name: string;
  weight: number;
}

interface Experiment {
  variants: WeightedVariant[];
}

// Cache for variant assignments (loaded once per session)
const variantCache: Record<string, string> = {};

/**
 * Get experiments config from feature flags
 */
function getExperiments(): Record<string, Experiment> {
  return featureFlagManager.get('experiments', {});
}

/**
 * Get user's variant for an experiment (cached, deterministic)
 * Supports weighted variants for unequal splits
 */
async function getVariant(experimentName: string): Promise<string | null> {
  const experiments = getExperiments();
  const experiment = experiments[experimentName];
  if (!experiment?.variants?.length) return null;
  
  // Check cache
  if (variantCache[experimentName]) {
    return variantCache[experimentName];
  }
  
  // Check persisted assignment
  const configKey = `abTest_${experimentName}`;
  const existing = await configManager.getValue(configKey);
  
  // Validate existing assignment is still a valid variant
  const variantNames = experiment.variants.map(v => v.name);
  if (existing && variantNames.includes(existing)) {
    variantCache[experimentName] = existing;
    return existing;
  }
  
  // New assignment based on clientId with weighted selection
  const clientId = await configManager.getOrCreateClientId();
  const hash = hashCode(clientId + experimentName);
  
  // Calculate total weight and select variant
  const totalWeight = experiment.variants.reduce((sum, v) => sum + v.weight, 0);
  
  let variant: string;
  if (totalWeight > 0) {
    const roll = hash % totalWeight;
    let cumulative = 0;
    variant = experiment.variants[0].name; // fallback
    for (const v of experiment.variants) {
      cumulative += v.weight;
      if (roll < cumulative) {
        variant = v.name;
        break;
      }
    }
  } else {
    // Fallback to equal split when weights are misconfigured (all zero)
    const index = hash % experiment.variants.length;
    variant = experiment.variants[index].name;
  }
  
  await configManager.setValue(configKey, variant);
  variantCache[experimentName] = variant;
  return variant;
}

/**
 * Check if a feature (variant name) is enabled for current user
 */
export async function hasFeature(featureName: string): Promise<boolean> {
  const experiments = getExperiments();
  if (!experiments || typeof experiments !== 'object') return false;
  
  for (const [expName, experiment] of Object.entries(experiments)) {
    const variantNames = experiment?.variants?.map(v => v.name) || [];
    if (variantNames.includes(featureName)) {
      const variant = await getVariant(expName);
      return variant === featureName;
    }
  }
  return false;
}

/**
 * Get all A/B test assignments for analytics (reads from config)
 */
export async function getABTestAssignments(): Promise<Record<string, string>> {
  const experiments = getExperiments();
  const assignments: Record<string, string> = {};
  
  for (const expName of Object.keys(experiments)) {
    const configKey = `abTest_${expName}`;
    const variant = await configManager.getValue(configKey);
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
