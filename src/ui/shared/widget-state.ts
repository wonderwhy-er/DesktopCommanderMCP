/**
 * Widget state persistence for MCP Apps hosts.
 * 
 * ChatGPT has a special extension (window.openai.widgetState) for persisting
 * widget state across page refreshes. Other hosts use the standard MCP Apps
 * pattern where ui/notifications/tool-result is re-sent when needed.
 * 
 * This module provides a simple abstraction:
 * - ChatGPT: Uses window.openai.widgetState
 * - Other hosts: No-op (rely on standard ui/notifications/tool-result)
 */

export interface WidgetStateStorage<T> {
    /** Read persisted state, returns undefined if not found or not supported */
    read(): T | undefined;
    /** Persist state for recovery after refresh (no-op on unsupported hosts) */
    write(state: T): void;
}

const FALLBACK_WIDGET_STATE_KEY_PREFIX = 'desktop-commander:widget-state';
const FALLBACK_WIDGET_INSTANCE_MARKER = '__dc_widget_id__:';

function createWidgetInstanceId(): string {
    const cryptoObject = typeof globalThis.crypto === 'object' ? globalThis.crypto : undefined;
    if (typeof cryptoObject?.randomUUID === 'function') {
        return cryptoObject.randomUUID();
    }

    return `widget-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function readWidgetInstanceIdFromWindowName(windowName: string): string | undefined {
    const markerIndex = windowName.indexOf(FALLBACK_WIDGET_INSTANCE_MARKER);
    if (markerIndex === -1) {
        return undefined;
    }

    const encodedValue = windowName
        .slice(markerIndex + FALLBACK_WIDGET_INSTANCE_MARKER.length)
        .split('|', 1)[0];
    if (!encodedValue) {
        return undefined;
    }

    try {
        return decodeURIComponent(encodedValue);
    } catch {
        return encodedValue;
    }
}

function getFallbackWidgetInstanceId(): string {
    if (typeof window === 'undefined') {
        return 'unknown-instance';
    }

    const currentWindowName = typeof window.name === 'string' ? window.name : '';
    const existingInstanceId = readWidgetInstanceIdFromWindowName(currentWindowName);
    if (existingInstanceId) {
        return existingInstanceId;
    }

    const instanceId = createWidgetInstanceId();
    const marker = `${FALLBACK_WIDGET_INSTANCE_MARKER}${encodeURIComponent(instanceId)}`;
    try {
        window.name = currentWindowName ? `${currentWindowName}|${marker}` : marker;
    } catch {
        // Ignore window.name write failures and fall back to the in-memory id.
    }
    return instanceId;
}

function getFallbackWidgetStateKey(): string {
    if (typeof window === 'undefined') {
        return `${FALLBACK_WIDGET_STATE_KEY_PREFIX}:unknown`;
    }

    const appPath = window.location.pathname || 'unknown';
    const instanceId = getFallbackWidgetInstanceId();
    return `${FALLBACK_WIDGET_STATE_KEY_PREFIX}:${appPath}:${encodeURIComponent(instanceId)}`;
}

function getSessionStorage(): Storage | undefined {
    if (typeof window === 'undefined') {
        return undefined;
    }

    try {
        return window.sessionStorage;
    } catch {
        return undefined;
    }
}

/**
 * Check if we're running in ChatGPT (has special widget state API)
 */
export function isChatGPT(): boolean {
    return typeof window !== 'undefined' &&
           typeof (window as any).openai?.setWidgetState === 'function';
}

/**
 * Create a widget state storage adapter.
 *
 * On ChatGPT: Uses window.openai.widgetState for persistence
 * On other hosts: Uses sessionStorage as a fallback so the preview can survive
 *   transient interruptions (page refresh on hosts that don't re-send tool_result,
 *   visibility/focus loss, etc.).
 *   The fallback cache key is scoped by app pathname and a per-frame widget id
 *   persisted in window.name, so different widgets in the same origin/session
 *   do not overwrite one another's cached state.
 */
export function createWidgetStateStorage<T>(
    validator?: (state: unknown) => boolean
): WidgetStateStorage<T> {
    if (!isChatGPT()) {
        const storage = getSessionStorage();
        const storageKey = getFallbackWidgetStateKey();
        return {
            read(): T | undefined {
                if (!storage) return undefined;
                try {
                    const raw = storage.getItem(storageKey);
                    if (!raw) return undefined;
                    const parsed = JSON.parse(raw);
                    const payload = parsed?.payload;
                    if (payload === undefined) return undefined;
                    if (validator && !validator(payload)) return undefined;
                    return payload as T;
                } catch {
                    return undefined;
                }
            },
            write(state: T): void {
                if (!storage) return;
                try {
                    storage.setItem(storageKey, JSON.stringify({ payload: state }));
                } catch {
                    // Ignore storage failures
                }
            }
        };
    }
    
    // ChatGPT-specific implementation
    return {
        read(): T | undefined {
            try {
                const state = (window as any).openai?.widgetState;
                if (state === undefined || state === null) return undefined;
                
                const payload = state.payload;
                if (payload === undefined) return undefined;
                
                if (validator && !validator(payload)) return undefined;
                return payload as T;
            } catch {
                return undefined;
            }
        },
        write(state: T): void {
            try {
                (window as any).openai?.setWidgetState?.({ payload: state });
            } catch {
                // Ignore write failures
            }
        }
    };
}
