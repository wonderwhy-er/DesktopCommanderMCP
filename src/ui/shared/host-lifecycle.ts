/**
 * Cross-tool lifecycle helpers for host readiness, teardown, and event subscriptions. It standardizes app lifecycle behavior across UI surfaces.
 */
import type { RpcClient } from './rpc-client.js';

interface UiHostLifecycleOptions {
  appName: string;
  appVersion?: string;
  getRootElement?: () => Element | null;
}

export interface UiHostLifecycle {
  notifyRender: () => void;
  observeResize: () => void;
  initialize: () => void;
}

export function createUiHostLifecycle(rpcClient: RpcClient, options: UiHostLifecycleOptions): UiHostLifecycle {
  const { appName, appVersion = '1.0.0', getRootElement } = options;
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
        app: { name: appName, version: appVersion },
        capabilities: {},
      }).catch(() => {
        // Initialization handshake failure should not break rendering.
      });
      rpcClient.notify('ui/notifications/initialized', {});
    },
  };
}
