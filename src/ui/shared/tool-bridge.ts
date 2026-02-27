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

function extractErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    return String(error);
}

export function createToolBridge(options: ToolBridgeOptions = {}) {
    const host = options.host ?? (globalThis as BridgeHost);
    const timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const targetOrigin = normalizeTargetOrigin(options.targetOrigin ?? getDefaultTargetOrigin());
    const idPrefix = options.idPrefix ?? 'tool-bridge';
    let requestCounter = 0;

    async function callViaFallback(name: string, args: ToolArgs): Promise<unknown> {
        if (!host.parent || !host.addEventListener || !host.removeEventListener) {
            throw new Error('JSON-RPC fallback is unavailable in this host environment.');
        }

        const parent = host.parent;
        const addListener = host.addEventListener;
        const removeListener = host.removeEventListener;

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

    async function callTool(name: string, args?: ToolArgs): Promise<unknown> {
        const normalizedArgs = normalizeToolArgs(args);
        const helperCandidates = [host.openai, host.mcp].filter(
            (candidate): candidate is ToolHelper => Boolean(candidate?.callTool)
        );

        let helperFailure: unknown;
        for (const helper of helperCandidates) {
            try {
                return await helper.callTool(name, normalizedArgs);
            } catch (error) {
                helperFailure = error;
            }
        }

        try {
            return await callViaFallback(name, normalizedArgs);
        } catch (fallbackError) {
            if (helperFailure) {
                throw new Error(
                    `Helper and fallback tool calls failed. Helper: ${extractErrorMessage(helperFailure)}. Fallback: ${extractErrorMessage(fallbackError)}`
                );
            }
            throw fallbackError;
        }
    }

    return {
        callTool,
    };
}
