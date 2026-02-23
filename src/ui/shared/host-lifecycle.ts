/**
 * Cross-tool lifecycle helpers for host readiness, teardown, and event subscriptions. It standardizes app lifecycle behavior across UI surfaces.
 */
import type { RpcClient } from './rpc-client.js';

interface UiHostLifecycleOptions {
  appName: string;
  appVersion?: string;
  getRootElement?: () => Element | null;
  onHostContext?: (hostContext: Record<string, unknown>) => void;
}

export interface UiHostLifecycle {
  notifyRender: () => void;
  observeResize: () => void;
  initialize: () => void;
}

export function createUiHostLifecycle(rpcClient: RpcClient, options: UiHostLifecycleOptions): UiHostLifecycle {
  const { appName, appVersion = '1.0.0', getRootElement, onHostContext } = options;
  const resolveRootElement = (): Element | null => getRootElement?.() ?? (document.getElementById('app')?.firstElementChild ?? document.getElementById('app'));

  const notifySizeChanged = (): void => {
    const node = resolveRootElement();
    const height = Math.max(28, Math.ceil(node?.getBoundingClientRect().height ?? 0));
    rpcClient.notify('ui/notifications/size-changed', { height });
  };

  return {
    notifyRender: () => {
      notifySizeChanged();
      setTimeout(notifySizeChanged, 80);
    },
    observeResize: () => {
      if (!window.ResizeObserver) {
        return;
      }
      const observer = new ResizeObserver(() => notifySizeChanged());
      observer.observe(document.documentElement);
    },
    initialize: () => {
      void rpcClient.request('ui/initialize', {
        appInfo: { name: appName, version: appVersion },
        appCapabilities: {},
        protocolVersion: '2026-01-26',
      }).then((response: unknown) => {
        if (onHostContext && response !== null && typeof response === 'object') {
          const hostContext = (response as Record<string, unknown>).hostContext;
          if (hostContext !== null && typeof hostContext === 'object') {
            onHostContext(hostContext as Record<string, unknown>);
          }
        }
        rpcClient.notify('ui/notifications/initialized', {});
      }).catch(() => {
        // Initialization handshake failure should not break rendering.
        // Still send initialized in case host is lenient.
        rpcClient.notify('ui/notifications/initialized', {});
      });
    },
  };
}
