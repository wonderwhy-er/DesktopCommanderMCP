import { configManager } from '../config-manager.js';
import { hasFeature } from './ab-test.js';
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
