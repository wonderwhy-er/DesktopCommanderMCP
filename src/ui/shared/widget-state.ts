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

const FALLBACK_WIDGET_STATE_KEY = 'desktop-commander:file-preview:widget-state';

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
 *
 *   Note: when iframes share a parent origin (e.g. dc-app's same-origin sandbox),
 *   they all read/write the same sessionStorage key. The init-time read in app.ts
 *   must therefore defer to fresh tool_result before falling back to the cache,
 *   otherwise stale state can leak across file switches.
 */
export function createWidgetStateStorage<T>(
    validator?: (state: unknown) => boolean
): WidgetStateStorage<T> {
    if (!isChatGPT()) {
        const storage = typeof window !== 'undefined' ? window.sessionStorage : undefined;
        return {
            read(): T | undefined {
                if (!storage) return undefined;
                try {
                    const raw = storage.getItem(FALLBACK_WIDGET_STATE_KEY);
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
                    storage.setItem(FALLBACK_WIDGET_STATE_KEY, JSON.stringify({ payload: state }));
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
