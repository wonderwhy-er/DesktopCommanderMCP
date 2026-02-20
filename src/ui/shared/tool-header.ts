/**
 * Reusable header renderer for MCP tool UIs. It provides a consistent title/description/status pattern so each app presents uniform top-of-page context.
 */
import { escapeHtml } from './escape-html.js';

export interface ToolHeaderConfig {
  pillLabel: string;
  pillClassName?: string;
  title: string;
  subtitle: string;
  badges: string[];
  actionsHtml: string;
}

export function renderToolHeader(config: ToolHeaderConfig): string {
  return `
    <header class="toolbar">
      <div class="meta">
        <div class="meta-main">
          <span class="file-pill ${escapeHtml(config.pillClassName ?? '')}">${escapeHtml(config.pillLabel)}</span>
          <div class="meta-text">
            <span class="filename" title="${escapeHtml(config.title)}">${escapeHtml(config.title)}</span>
            <span class="filepath" title="${escapeHtml(config.subtitle)}">${escapeHtml(config.subtitle)}</span>
          </div>
        </div>
        <div class="meta-badges">
          ${config.badges.map((badge) => `<span class="badge">${escapeHtml(badge)}</span>`).join('')}
        </div>
      </div>
      <div class="actions">
        ${config.actionsHtml}
      </div>
    </header>
  `;
}
