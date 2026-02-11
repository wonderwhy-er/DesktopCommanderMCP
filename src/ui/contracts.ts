/**
 * Central constants and shape contracts for UI resource identifiers. It gives one source of truth for URIs/tool metadata shared between server handlers and UI loaders.
 */
export const FILE_PREVIEW_RESOURCE_URI = 'ui://desktop-commander/file-preview';

export interface UiToolMeta extends Record<string, unknown> {
  'ui/resourceUri': string;
  'openai/outputTemplate': string;
  ui: {
    resourceUri: string;
  };
  'openai/widgetAccessible'?: boolean;
}

export function buildUiToolMeta(resourceUri: string, widgetAccessible = false): UiToolMeta {
  const meta: UiToolMeta = {
    'ui/resourceUri': resourceUri,
    'openai/outputTemplate': resourceUri,
    ui: {
      resourceUri,
    },
  };

  if (widgetAccessible) {
    meta['openai/widgetAccessible'] = true;
  }

  return meta;
}
