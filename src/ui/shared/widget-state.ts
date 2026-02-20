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
 * On other hosts: Returns no-op adapter (state comes from ui/notifications/tool-result)
 */
export function createWidgetStateStorage<T>(
    validator?: (state: unknown) => boolean
): WidgetStateStorage<T> {
    
    if (!isChatGPT()) {
        // Other hosts don't have widget state persistence - return no-op
        return {
            read: () => undefined,
            write: () => {}
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
