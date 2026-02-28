import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';

export interface UiChromeState {
    expanded: boolean;
    hideSummaryRow: boolean;
    compact?: boolean;
}

export interface ConnectWithSharedHostContextOptions {
    app: App;
    chrome: UiChromeState;
    onContextApplied?: () => void;
    onConnected?: () => void | Promise<void>;
}

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

export function applySharedHostContext(context: unknown, chrome: UiChromeState): void {
    if (!isObjectRecord(context)) {
        return;
    }

    if (context.theme === 'light' || context.theme === 'dark') {
        applyDocumentTheme(context.theme);
    }

    const styles = isObjectRecord(context.styles) ? context.styles : null;
    const variables = isObjectRecord(styles?.variables) ? styles.variables : null;
    const css = isObjectRecord(styles?.css) ? styles.css : null;
    const fonts = typeof css?.fonts === 'string' ? css.fonts : null;

    if (variables) {
        applyHostStyleVariables(variables as Record<string, string>);
    }
    if (fonts) {
        applyHostFonts(fonts);
    }

    if (typeof context.initiallyExpanded === 'boolean') {
        chrome.expanded = context.initiallyExpanded;
    }

    if (typeof context.compact === 'boolean' && typeof chrome.compact === 'boolean') {
        chrome.compact = context.compact;
    }

    if (typeof context.hideSummaryRow === 'boolean') {
        chrome.hideSummaryRow = context.hideSummaryRow;
        if (context.hideSummaryRow) {
            chrome.expanded = true;
            if (typeof chrome.compact === 'boolean') {
                chrome.compact = true;
            }
        }
    }
}

export async function connectWithSharedHostContext(options: ConnectWithSharedHostContextOptions): Promise<void> {
    const { app, chrome, onContextApplied, onConnected } = options;

    app.onhostcontextchanged = (context) => {
        applySharedHostContext(context, chrome);
        onContextApplied?.();
    };

    await app.connect();

    const hostContext = app.getHostContext();
    if (hostContext) {
        applySharedHostContext(hostContext, chrome);
        onContextApplied?.();
    }

    await onConnected?.();
}
