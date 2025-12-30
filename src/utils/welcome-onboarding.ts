import { configManager } from '../config-manager.js';
import { hasFeature } from './ab-test.js';
import { featureFlagManager } from './feature-flags.js';
import { openWelcomePage } from './open-browser.js';
import { logToStderr } from './logger.js';
import { capture } from './capture.js';

/**
 * Handle welcome page display for new users (A/B test controlled)
 * 
 * Only shows to:
 * 1. New users (pendingWelcomeOnboarding flag set when config created)
 * 2. Users in the 'showOnboardingPage' A/B variant
 * 3. Haven't seen it yet
 */
export async function handleWelcomePageOnboarding(): Promise<void> {
  // Check if this is a new install pending A/B decision
  // This flag is set when config is first created and survives process restarts
  const pending = await configManager.getValue('pendingWelcomeOnboarding');
  if (!pending) {
    return; // Existing user or already processed
  }

  // Track that we have a first-run user attempting onboarding
  const loadedFromCache = featureFlagManager.wasLoadedFromCache();
  
  // For new users, we need to wait for feature flags to load from network
  // since they won't have a cache file yet. Without this, hasFeature() would
  // return false (no experiments defined) and all new users go to control.
  if (!loadedFromCache) {
    logToStderr('debug', 'Waiting for feature flags to load...');
    await featureFlagManager.waitForFreshFlags();
  }

  // Check A/B test assignment
  const shouldShow = await hasFeature('showOnboardingPage');
  
  // Track the A/B decision
  capture('server_welcome_page_ab_decision', {
    variant: shouldShow ? 'treatment' : 'control',
    loaded_from_cache: loadedFromCache
  });
  
  if (!shouldShow) {
    // Mark as control group for analytics - this will be sent with all future events
    await configManager.setValue('sawOnboardingPage', false);
    await configManager.setValue('pendingWelcomeOnboarding', false);
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
    await configManager.setValue('pendingWelcomeOnboarding', false);
    capture('server_welcome_page_opened', { success: true });
    logToStderr('info', 'Welcome page opened');
  } catch (e) {
    // Still clear the pending flag even on failure - don't retry forever
    await configManager.setValue('pendingWelcomeOnboarding', false);
    capture('server_welcome_page_opened', { success: false, error: e instanceof Error ? e.message : String(e) });
    logToStderr('warning', `Failed to open welcome page: ${e instanceof Error ? e.message : e}`);
  }
}
