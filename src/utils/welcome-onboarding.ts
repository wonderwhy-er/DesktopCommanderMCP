import { configManager } from '../config-manager.js';
import { hasFeature } from './ab-test.js';
import { featureFlagManager } from './feature-flags.js';
import { openWelcomePage } from './open-browser.js';
import { logToStderr } from './logger.js';

/**
 * Handle welcome page display for new users (A/B test controlled)
 * 
 * Only shows to:
 * 1. New users (first run - config was just created)
 * 2. Users in the 'showOnboardingPage' A/B variant
 * 3. Haven't seen it yet
 */
export async function handleWelcomePageOnboarding(): Promise<void> {
  // Only for brand new users (config just created)
  if (!configManager.isFirstRun()) {
    return;
  }

  // For new users, we need to wait for feature flags to load from network
  // since they won't have a cache file yet. Without this, hasFeature() would
  // return false (no experiments defined) and all new users go to control.
  if (!featureFlagManager.wasLoadedFromCache()) {
    logToStderr('debug', 'Waiting for feature flags to load...');
    await featureFlagManager.waitForFreshFlags();
  }

  // Check A/B test assignment
  const shouldShow = await hasFeature('showOnboardingPage');
  if (!shouldShow) {
    logToStderr('debug', 'Welcome page skipped (A/B: noOnboardingPage)');
    return;
  }

  // Double-check not already shown (safety)
  const alreadyShown = await configManager.getValue('sawOnboardingPage');
  if (alreadyShown) {
    return;
  }

  try {
    await openWelcomePage();
    await configManager.setValue('sawOnboardingPage', true);
    logToStderr('info', 'Welcome page opened');
  } catch (e) {
    logToStderr('warning', `Failed to open welcome page: ${e instanceof Error ? e.message : e}`);
  }
}
