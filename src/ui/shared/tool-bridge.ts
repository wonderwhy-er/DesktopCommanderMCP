type ToolArgs = Record<string, unknown>;

type ToolHelper = {
    callTool: (name: string, args: ToolArgs) => Promise<unknown> | unknown;
};

type MessageEventLike = {
    data: unknown;
    origin?: string;
    source?: unknown;
};

type MessageListener = (event: MessageEventLike) => void;

type MessageTarget = {
    postMessage: (message: unknown, targetOrigin?: string) => void;
};

type BridgeHost = {
    openai?: ToolHelper;
    mcp?: ToolHelper;
    parent?: MessageTarget;
    addEventListener?: (type: 'message', listener: MessageListener) => void;
    removeEventListener?: (type: 'message', listener: MessageListener) => void;
};

export interface ToolBridgeOptions {
    host?: BridgeHost;
    requestTimeoutMs?: number;
    targetOrigin?: string;
    idPrefix?: string;
}

const DEFAULT_TIMEOUT_MS = 5000;

function getDefaultTargetOrigin(): string {
    if (typeof document === 'undefined') {
        return '*';
    }

    const referrer = document.referrer;
    if (typeof referrer !== 'string' || referrer.trim().length === 0) {
        return '*';
    }

    try {
        return new URL(referrer).origin;
    } catch {
        return '*';
    }
}

function normalizeTargetOrigin(value: string): string {
    if (value === '*') {
        return value;
    }

    try {
        return new URL(value).origin;
    } catch {
        throw new Error(`Invalid targetOrigin: ${value}`);
    }
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function normalizeToolArgs(args: ToolArgs | undefined): ToolArgs {
    return args ?? {};
}

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    if (isObject(value)) {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? String(value);
}

function extractErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    return String(error);
}

function isHelperUnavailableError(error: unknown): boolean {
    if (!isObject(error)) {
        return false;
    }

    const code = typeof error.code === 'string' ? error.code.toLowerCase() : '';
    if (code === 'not_implemented' || code === 'not_supported' || code === 'unavailable') {
        return true;
    }

    const message = extractErrorMessage(error).toLowerCase();
    return message.includes('not implemented')
        || message.includes('not supported')
        || message.includes('unavailable')
        || message.includes('not available');
}

export function createToolBridge(options: ToolBridgeOptions = {}) {
    const host = options.host ?? (globalThis as BridgeHost);
    const timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const targetOrigin = normalizeTargetOrigin(options.targetOrigin ?? getDefaultTargetOrigin());
    const idPrefix = options.idPrefix ?? 'tool-bridge';
    let requestCounter = 0;
    const inFlight = new Map<string, Promise<unknown>>();

    async function callViaFallback(name: string, args: ToolArgs): Promise<unknown> {
        if (!host.parent || !host.addEventListener || !host.removeEventListener) {
            throw new Error('JSON-RPC fallback is unavailable in this host environment.');
        }

        const parent = host.parent;
        const addListener = (type: 'message', listener: MessageListener): void => {
            host.addEventListener?.(type, listener);
        };
        const removeListener = (type: 'message', listener: MessageListener): void => {
            host.removeEventListener?.(type, listener);
        };

        requestCounter += 1;
        const requestId = `${idPrefix}:${requestCounter}`;

        return new Promise((resolve, reject) => {
            const timeoutHandle = setTimeout(() => {
                removeListener('message', onMessage);
                reject(new Error(`Tool call fallback timed out after ${timeoutMs}ms (request: ${requestId})`));
            }, timeoutMs);

            const onMessage: MessageListener = (event) => {
                const payload = event.data;
                if (event.source !== parent) {
                    return;
                }
                if (targetOrigin !== '*' && event.origin !== targetOrigin) {
                    return;
                }
                if (!isObject(payload) || payload.id !== requestId) {
                    return;
                }

                clearTimeout(timeoutHandle);
                removeListener('message', onMessage);

                if (isObject(payload.error)) {
                    const rawMessage = payload.error.message;
                    const message = typeof rawMessage === 'string'
                        ? rawMessage
                        : 'Unknown tools/call fallback error';
                    reject(new Error(`Tool call fallback failed: ${message}`));
                    return;
                }

                resolve(payload.result);
            };

            addListener('message', onMessage);
            parent.postMessage(
                {
                    jsonrpc: '2.0',
                    id: requestId,
                    method: 'tools/call',
                    params: {
                        name,
                        arguments: args,
                    },
                },
                targetOrigin
            );
        });
    }

    async function callToolOnce(name: string, normalizedArgs: ToolArgs): Promise<unknown> {
        const helperCandidates = [host.openai, host.mcp].filter(
            (candidate): candidate is ToolHelper => Boolean(candidate?.callTool)
        );

        for (const helper of helperCandidates) {
            try {
                return await helper.callTool(name, normalizedArgs);
            } catch (error) {
                if (isHelperUnavailableError(error)) {
                    continue;
                }
                throw new Error(`Tool helper call failed: ${extractErrorMessage(error)}`);
            }
        }

        try {
            return await callViaFallback(name, normalizedArgs);
        } catch (fallbackError) {
            throw fallbackError;
        }
    }

    async function callTool(name: string, args?: ToolArgs): Promise<unknown> {
        const normalizedArgs = normalizeToolArgs(args);
        const key = `${name}:${stableStringify(normalizedArgs)}`;
        const existing = inFlight.get(key);
        if (existing) {
            return existing;
        }

        const pending = callToolOnce(name, normalizedArgs);
        inFlight.set(key, pending);
        try {
            return await pending;
        } finally {
            if (inFlight.get(key) === pending) {
                inFlight.delete(key);
            }
        }
    }

    return {
        callTool,
    };
}
