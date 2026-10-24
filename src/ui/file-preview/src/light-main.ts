/**
 * Small MCP App shell. It does not import Markdown/code-rendering/editor modules.
 * The full renderer is transferred and evaluated only after a human clicks.
 */
import type { App } from '@modelcontextprotocol/ext-apps';
import { createWidgetStateStorage } from '../../shared/widget-state.js';
import type { UiChromeState } from '../../shared/host-context.js';
import { LiteMcpApp } from './lite-app.js';
import {
  createLazyPreviewState, createLazyStateFromLegacy, isLazyPreviewState,
  type LazyPreviewState,
} from './lazy-preview-state.js';
import type { RenderPayload } from './model.js';

function applyLightHostContext(context: Record<string, unknown> | undefined, chrome: UiChromeState): void {
  if (!context) return;
  if (context.theme === 'light' || context.theme === 'dark') {
    document.documentElement.setAttribute('data-theme', context.theme);
    document.documentElement.style.colorScheme = context.theme;
  }
  const styles = context.styles as { variables?: Record<string, unknown> } | undefined;
  for (const [name, value] of Object.entries(styles?.variables ?? {})) {
    if (typeof value === 'string') document.documentElement.style.setProperty(name, value);
  }
  if (typeof context.initiallyExpanded === 'boolean') chrome.expanded = context.initiallyExpanded;
  if (typeof context.hideSummaryRow === 'boolean') {
    chrome.hideSummaryRow = context.hideSummaryRow;
    if (context.hideSummaryRow) chrome.expanded = true;
  }
}

const container = document.getElementById('app');
if (container) {
  const root = container;
  const app = new LiteMcpApp(
    { name: 'Desktop Commander File Preview', version: '1.0.0' },
    { updateModelContext: { text: {} } },
    true,
  );
  const stateStore = createWidgetStateStorage<LazyPreviewState | RenderPayload>(
    (value) => isLazyPreviewState(value) || (
      value !== null && typeof value === 'object'
      && typeof (value as RenderPayload).filePath === 'string'
      && typeof (value as RenderPayload).content === 'string'
    ),
  );
  let currentState: LazyPreviewState | undefined;
  let generation = 0;
  let pendingMutation = false;
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  const chrome: UiChromeState = { expanded: false, hideSummaryRow: false };

  function clearPendingTimer(): void {
    if (pendingTimer !== undefined) clearTimeout(pendingTimer);
    pendingTimer = undefined;
  }

  function readArgsFromTool(input: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!input) return;
    const path = typeof input.path === 'string' ? input.path
      : typeof input.file_path === 'string' ? input.file_path : undefined;
    if (!path) return;
    const args: Record<string, unknown> = { path };
    for (const key of ['offset', 'length', 'sheet', 'range', 'isUrl']) {
      if (input[key] !== undefined) args[key] = input[key];
    }
    return args;
  }

  function toolFromInput(input: Record<string, unknown> | undefined): LazyPreviewState['sourceTool'] {
    if (!input) return 'read_file';
    if (input.old_string !== undefined || input.new_string !== undefined) return 'edit_block';
    if (input.content !== undefined) return 'write_file';
    return 'read_file';
  }

  function showCard(state: LazyPreviewState, message?: string, pending = false): void {
    currentState = state;
    const version = ++generation;
    const path = state.readArgs.path as string;
    const name = path.split(/[\\/]/).pop() || path;
    const shell = document.createElement('main');
    shell.className = 'shell lazy-preview-shell';
    const button = document.createElement('button');
    button.className = 'compact-row compact-row--ready lazy-preview-open';
    button.type = 'button';
    button.title = path;
    button.setAttribute('aria-expanded', 'false');
    button.textContent = message ?? ('View preview: ' + name);
    button.disabled = pending;
    shell.appendChild(button);
    root.replaceChildren(shell);
    document.body.classList.add('dc-ready');
    button.addEventListener('click', () => void loadViewer(state, button, version));
  }

  function showStatus(message: string): void {
    ++generation;
    const shell = document.createElement('main');
    shell.className = 'shell';
    const row = document.createElement('div');
    row.className = 'compact-row compact-row--status';
    row.textContent = message;
    shell.appendChild(row);
    root.replaceChildren(shell);
    document.body.classList.add('dc-ready');
  }


  async function loadViewer(state: LazyPreviewState, button: HTMLButtonElement, version: number): Promise<void> {
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = 'Loading preview viewer...';
    try {
      // The server returns only its own fixed bundled JS, never a user-selected path.
      const response = await app.callServerTool({
        name: 'get_file_preview_runtime', arguments: { origin: 'ui' },
      });
      if ((response as { isError?: boolean }).isError) throw new Error('Viewer runtime not available');
      const block = response.content?.find((item) => item.type === 'text');
      if (!block || block.type !== 'text' || !block.text) throw new Error('Empty viewer runtime');
      if (typeof DecompressionStream !== 'function') throw new Error('This browser cannot decompress the viewer');
      // Base64 + gzip keeps the large viewer off the initial page and out of the model's context.
      const encoded = block.text;
      const bytes = Uint8Array.from(atob(encoded), (ch) => ch.charCodeAt(0));
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      const js = await new Response(stream).text();
      if (version !== generation || currentState !== state) return;
      // Under MCP Apps' standard inline-script CSP. A restrictive host may reject it.
      const script = document.createElement('script');
      script.textContent = js;
      document.body.appendChild(script);
      script.remove();
      const start = (window as unknown as { __dcStartFilePreview?: (app: App) => void }).__dcStartFilePreview;
      if (typeof start !== 'function') throw new Error('Viewer did not initialize (possible host CSP restriction)');
      start(app as unknown as App); // Reuse the connected MCP App; never do a second handshake.
    } catch (error) {
      if (version !== generation) return;
      const reason = error instanceof Error ? error.message : String(error);
      showCard(state, 'Retry preview: ' + reason);
    }
  }

  app.ontoolinput = (params) => {
    clearPendingTimer();
    pendingMutation = false;
    const input = params.arguments as Record<string, unknown> | undefined;
    const args = readArgsFromTool(input);
    if (!args) { showStatus('No preview available for this tool'); return; }
    const sourceTool = toolFromInput(input);
    const state = createLazyPreviewState(args, sourceTool);
    stateStore.write(state);
    pendingMutation = sourceTool === 'write_file' || sourceTool === 'edit_block';
    showCard(state, undefined, pendingMutation);

    if (pendingMutation) {
      pendingTimer = setTimeout(() => {
        pendingTimer = undefined;
        if (pendingMutation && currentState === state) {
          pendingMutation = false;
          showCard(state, 'Retry preview after file update');
        }
      }, 10000);
    }
  };

  app.ontoolresult = (result) => {
    clearPendingTimer();
    if ((result as { isError?: boolean }).isError) {
      pendingMutation = false;
      showStatus('File operation failed; preview not available');
      return;
    }
    if (pendingMutation && currentState) {
      pendingMutation = false;
      showCard(currentState);
    }
  };

  app.ontoolcancelled = (params) => {
    clearPendingTimer();
    pendingMutation = false;
    showStatus(params.reason ?? 'File operation cancelled');
  };

  app.onteardown = async () => {
    clearPendingTimer();
    ++generation;
    return {};
  };

  app.onhostcontextchanged = (context) => {
    applyLightHostContext(context, chrome);
  };

  showStatus('Preparing file preview...');
  void app.connect().then(() => {
    applyLightHostContext(app.getHostContext(), chrome);
    const saved = stateStore.read();
    if (!saved) { showStatus('File preview available when a file is selected'); return; }
    const state = isLazyPreviewState(saved) ? saved : createLazyStateFromLegacy(saved);
    if (!isLazyPreviewState(saved)) stateStore.write(state);
    showCard(state);
  }).catch(() => showStatus('Failed to connect to preview host'));
}
