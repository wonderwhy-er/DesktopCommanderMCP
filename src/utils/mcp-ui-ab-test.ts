import { configManager } from '../config-manager.js';
import { getABTestVariant } from './ab-test.js';
import { capture } from './capture.js';
import { featureFlagManager } from './feature-flags.js';

export const MCP_UI_EXPERIMENT_NAME = 'McpUiPreviews';
export const MCP_UI_SHOW_VARIANT = 'showMCPUi';
export const MCP_UI_HIDE_VARIANT = 'notShowMCPUi';

export interface McpUiPreviewDecisionDeps {
  getUserOverride: () => Promise<unknown>;
  getExistingAssignment: () => Promise<unknown>;
  isFirstRun: () => boolean;
  wasLoadedFromCache: () => boolean;
  waitForFreshFlags: () => Promise<void>;
  getABTestVariant: (experimentName: string) => Promise<string | null>;
  capture: (event: string, properties?: Record<string, unknown>) => Promise<unknown> | unknown;
}

function variantEnablesMcpUi(variant: unknown): boolean | null {
  if (variant === MCP_UI_HIDE_VARIANT) return false;
  if (variant === MCP_UI_SHOW_VARIANT) return true;
  return null;
}

export async function resolveMcpUiPreviewDecision(deps: McpUiPreviewDecisionDeps): Promise<boolean> {
  try {
    // An explicit user choice (showMcpUI config) always wins over the A/B test.
    // Unset (or any non-boolean) means "automatic": fall through to the experiment.
    const userOverride = await deps.getUserOverride();
    if (typeof userOverride === 'boolean') {
      return userOverride;
    }

    const existingAssignment = await deps.getExistingAssignment();
    const existingDecision = variantEnablesMcpUi(existingAssignment);
    if (existingDecision !== null) {
      if (!deps.wasLoadedFromCache()) {
        await deps.waitForFreshFlags();
      }

      const currentVariant = await deps.getABTestVariant(MCP_UI_EXPERIMENT_NAME);
      return variantEnablesMcpUi(currentVariant) ?? existingDecision;
    }

    if (!deps.isFirstRun()) {
      return true;
    }

    if (!deps.wasLoadedFromCache()) {
      await deps.waitForFreshFlags();
    }

    const variant = await deps.getABTestVariant(MCP_UI_EXPERIMENT_NAME);
    const decision = variantEnablesMcpUi(variant);
    if (decision === null) {
      return true;
    }

    try {
      await deps.capture('server_mcp_ui_ab_decision', {
        experiment: MCP_UI_EXPERIMENT_NAME,
        variant,
        mcp_ui_enabled: decision,
      });
    } catch {
      // Telemetry must not change the assigned product experience.
    }

    return decision;
  } catch {
    return true;
  }
}

// Decided once per server process: a session must render consistently. Flipping
// tool UI _meta mid-session confuses hosts (open widgets / other threads sharing
// this server see tools lose their UI), so config/flag changes made while the
// server is running take effect on the next restart.
let sessionDecision: Promise<boolean> | null = null;

export async function shouldShowMcpUiPreviews(): Promise<boolean> {
  if (!sessionDecision) {
    sessionDecision = resolveMcpUiPreviewDecision({
      getUserOverride: () => configManager.getValue('showMcpUI'),
      getExistingAssignment: () => configManager.getValue(`abTest_${MCP_UI_EXPERIMENT_NAME}`),
      isFirstRun: () => configManager.isFirstRun(),
      wasLoadedFromCache: () => featureFlagManager.wasLoadedFromCache(),
      waitForFreshFlags: () => featureFlagManager.waitForFreshFlags(),
      getABTestVariant,
      capture,
    });
  }
  return sessionDecision;
}
