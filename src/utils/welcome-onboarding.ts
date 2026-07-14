import { configManager } from '../config-manager.js';
import { hasFeature } from './ab-test.js';
import { featureFlagManager } from './feature-flags.js';
import { openWelcomePage } from './open-browser.js';
import { logToStderr } from './logger.js';
import { capture } from './capture.js';

/** Consume a pending welcome page when this client must never receive it. */
export async function skipWelcomePageOnboarding(): Promise<void> {
  const pending = await configManager.getValue('pendingWelcomeOnboarding');
  if (!pending) {
    return;
  }

  await configManager.setValue('pendingWelcomeOnboarding', false);
  logToStderr('debug', 'Welcome page skipped');
}

function isWelcomePageClientExcluded(clientName?: string): boolean {
  const configuredClients = featureFlagManager.get('welcome_page_excluded_clients', []);
  if (!Array.isArray(configuredClients) || !clientName) {
    return false;
  }

  const normalizedClientName = clientName.trim().toLowerCase();
  return configuredClients.some(
    (configuredClient) => typeof configuredClient === 'string'
      && configuredClient.trim().toLowerCase() === normalizedClientName
  );
}

/**
 * Handle welcome page display for new users (A/B test controlled)
 * 
 * Only shows to:
 * 1. New users (pendingWelcomeOnboarding flag set when config created)
 * 2. Users in the 'showOnboardingPage' A/B variant
 * 3. Haven't seen it yet
 */
export async function handleWelcomePageOnboarding(clientName?: string): Promise<void> {
  // Existing configs are migrated to false. Only configs created with the
  // eligibility marker may receive this welcome-page campaign.
  const eligible = await configManager.getValue('welcomeOnboardingEligible');
  if (!eligible) {
    return;
  }

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

  // Keep an MCP release compatible with an older flag document: only an
  // explicit false disables. Absent or malformed values fail open so a flag
  // file typo cannot permanently consume pending onboarding for new installs.
  const enabled = featureFlagManager.get('welcome_page_enabled', true) !== false;
  if (!enabled) {
    await skipWelcomePageOnboarding();
    return;
  }

  if (isWelcomePageClientExcluded(clientName)) {
    await skipWelcomePageOnboarding();
    return;
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
    await openWelcomePage(clientName);
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
