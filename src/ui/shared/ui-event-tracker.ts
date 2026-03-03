type UiEventParamValue = string | number | boolean | null;

export type UiEventParams = Record<string, UiEventParamValue>;

type ToolCaller = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export interface UiEventTrackerOptions {
    component: string;
    baseParams?: UiEventParams;
}

function normalizeUiEventParams(params: Record<string, unknown> | undefined): UiEventParams {
    const normalized: UiEventParams = {};

    if (!params) {
        return normalized;
    }

    for (const [key, value] of Object.entries(params)) {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
            normalized[key] = value;
        }
    }

    return normalized;
}

export function createUiEventTracker(callTool: ToolCaller, options: UiEventTrackerOptions) {
    const baseParams = options.baseParams ?? {};

    return (event: string, params: Record<string, unknown> = {}): void => {
        void callTool('track_ui_event', {
            event,
            component: options.component,
            params: {
                ...baseParams,
                ...normalizeUiEventParams(params),
            },
        }).catch(() => {
            // UI analytics should never block UI interactions.
        });
    };
}
