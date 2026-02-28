import { escapeHtml } from './escape-html.js';

interface RenderCompactRowOptions {
  id?: string;
  label: string;
  filename?: string;
  variant?: 'ready' | 'loading' | 'status';
  expandable?: boolean;
  expanded?: boolean;
  interactive?: boolean;
}

export function renderCompactRow(options: RenderCompactRowOptions): string {
  const variant = options.variant ?? 'ready';
  const classNames = `compact-row compact-row--${variant}`;
  const id = options.id ? ` id="${escapeHtml(options.id)}"` : '';
  const interactive = options.interactive ?? variant === 'ready';
  const role = interactive ? ' role="button" tabindex="0"' : '';
  const ariaExpanded = typeof options.expanded === 'boolean'
    ? ` aria-expanded="${String(options.expanded)}"`
    : '';
  const chevron = options.expandable
    ? '<svg class="compact-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 6l6 6-6 6z"/></svg>'
    : '';
  const filename = options.filename
    ? `<span class="compact-filename">${escapeHtml(options.filename)}</span>`
    : '';

  return `<div class="${classNames}"${id}${role}${ariaExpanded}>${chevron}<span class="compact-label">${escapeHtml(options.label)}</span>${filename}</div>`;
}
