import type { App } from '@modelcontextprotocol/ext-apps';
import { bootstrapApp } from './app.js';
import type { LazyPreviewState } from './lazy-preview-state.js';

// The small shell already connected to the MCP host. Reuse that bridge.
(window as unknown as { __dcStartFilePreview?: (app: App, state?: LazyPreviewState) => void }).__dcStartFilePreview = (app, state) => {
  bootstrapApp(app, true, true, state);
};
