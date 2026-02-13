/**
 * Shared RPC client abstraction for window-message communication with the MCP host. It handles request IDs, timeouts, error normalization, and trust checks.
 */
interface RpcErrorShape {
  message?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface RpcClient {
  notify: (method: string, params: Record<string, unknown>) => void;
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  handleMessageEvent: (event: MessageEvent) => boolean;
  dispose: () => void;
}

export interface RpcClientOptions {
  targetWindow: Window;
  targetOrigin?: string;
  timeoutMs?: number;
  isTrustedSource?: (source: MessageEvent['source'] | null) => boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isTrustedParentMessageSource(source: MessageEvent['source'] | null, expectedSource: Window): boolean {
  return source === expectedSource;
}

export function createWindowRpcClient(options: RpcClientOptions): RpcClient {
  const {
    targetWindow,
    targetOrigin = '*',
    timeoutMs = 15000,
    isTrustedSource = () => true,
  } = options;

  let requestId = 1;
  const pendingRequests = new Map<number, PendingRequest>();

  const postMessage = (payload: Record<string, unknown>): void => {
    targetWindow.postMessage(payload, targetOrigin);
  };

  const notify = (method: string, params: Record<string, unknown>): void => {
    postMessage({
      jsonrpc: '2.0',
      method,
      params,
    });
  };

  const request = (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const id = requestId++;

    postMessage({
      jsonrpc: '2.0',
      id,
      method,
      params,
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error(`Request timed out for method ${method}`));
      }, timeoutMs);

      pendingRequests.set(id, { resolve, reject, timer });
    });
  };

  const handleMessageEvent = (event: MessageEvent): boolean => {
    if (!isTrustedSource(event.source)) {
      return false;
    }

    if (!isObject(event.data) || typeof event.data.id !== 'number') {
      return false;
    }

    const pending = pendingRequests.get(event.data.id);
    if (!pending) {
      return false;
    }

    clearTimeout(pending.timer);
    pendingRequests.delete(event.data.id);

    if (isObject(event.data.error)) {
      const errorShape = event.data.error as RpcErrorShape;
      const message = typeof errorShape.message === 'string' ? errorShape.message : 'Unknown RPC error';
      pending.reject(new Error(message));
      return true;
    }

    pending.resolve(event.data.result);
    return true;
  };

  const dispose = (): void => {
    for (const [id, pending] of pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('RPC client disposed'));
      pendingRequests.delete(id);
    }
  };

  return {
    notify,
    request,
    handleMessageEvent,
    dispose,
  };
}
