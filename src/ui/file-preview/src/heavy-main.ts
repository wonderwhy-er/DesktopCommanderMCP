import type { App } from '@modelcontextprotocol/ext-apps';
import { bootstrapApp } from './app.js';

// The small shell already connected to the MCP host. Reuse that bridge.
(window as unknown as { __dcStartFilePreview?: (app: App) => void }).__dcStartFilePreview = (app) => {
  bootstrapApp(app, true, true);
};
