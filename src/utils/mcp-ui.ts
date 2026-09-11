import { configManager } from '../config-manager.js';

/**
 * Whether tools advertise interactive MCP UI widgets. Shown by default; a
 * boolean showMcpUI config value is an explicit user override. Any non-boolean
 * value (unset, or a stringly-typed "false") means the default applies.
 */
export function mcpUiEnabledFor(userOverride: unknown): boolean {
  return typeof userOverride === 'boolean' ? userOverride : true;
}

// Decided once per server process: a session must render consistently. Flipping
// tool UI _meta mid-session confuses hosts (open widgets / other threads sharing
// this server see tools lose their UI), so config changes made while the server
// is running take effect on the next restart.
let sessionDecision: Promise<boolean> | null = null;

export async function shouldShowMcpUi(): Promise<boolean> {
  if (!sessionDecision) {
    sessionDecision = configManager.getValue('showMcpUI')
      .then(mcpUiEnabledFor)
      .catch(() => true);
  }
  return sessionDecision;
}
