import { getParentDirectory } from '../path-utils.js';

export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function encodePowerShellCommand(script: string): string {
    const utf16leBytes: number[] = [];
    for (let index = 0; index < script.length; index += 1) {
        const codeUnit = script.charCodeAt(index);
        utf16leBytes.push(codeUnit & 0xff, codeUnit >> 8);
    }

    let binary = '';
    for (const byte of utf16leBytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

export function buildOpenInFolderCommand(filePath: string, isLikelyUrl: (filePath: string) => boolean): string | undefined {
    const trimmedPath = filePath.trim();
    if (!trimmedPath || isLikelyUrl(trimmedPath)) {
        return undefined;
    }

    const userAgent = navigator.userAgent.toLowerCase();
    if (userAgent.includes('win')) {
        const escapedForPowerShell = trimmedPath.replace(/'/g, "''");
        const script = `Start-Process -FilePath explorer.exe -ArgumentList @('/select,','${escapedForPowerShell}')`;
        return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodePowerShellCommand(script)}`;
    }
    if (userAgent.includes('mac')) {
        return `open -R ${shellQuote(trimmedPath)}`;
    }

    return `xdg-open ${shellQuote(getParentDirectory(trimmedPath))}`;
}

export function buildOpenInEditorCommand(
    filePath: string,
    isLikelyUrl: (filePath: string) => boolean,
    editorAppCache: Map<string, { appName: string; appPath?: string }>
): string | undefined {
    const trimmedPath = filePath.trim();
    if (!trimmedPath || isLikelyUrl(trimmedPath)) {
        return undefined;
    }

    const cachedApp = editorAppCache.get(trimmedPath);
    if (cachedApp?.appPath && navigator.userAgent.toLowerCase().includes('mac')) {
        return `open -a ${shellQuote(cachedApp.appPath)} ${shellQuote(trimmedPath)}`;
    }

    const userAgent = navigator.userAgent.toLowerCase();
    if (userAgent.includes('win')) {
        const escapedForPowerShell = trimmedPath.replace(/'/g, "''");
        const script = `Start-Process -FilePath '${escapedForPowerShell}'`;
        return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodePowerShellCommand(script)}`;
    }
    if (userAgent.includes('mac')) {
        return `open ${shellQuote(trimmedPath)}`;
    }

    return `xdg-open ${shellQuote(trimmedPath)}`;
}

export async function detectDefaultMarkdownEditor(options: {
    filePath: string;
    editorAppCache: Map<string, { appName: string; appPath?: string }>;
    editorAppPending: Set<string>;
    callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown | undefined>;
    extractToolText: (value: unknown) => string | undefined;
    onDetected?: () => void;
}): Promise<void> {
    const trimmedPath = options.filePath.trim();
    if (!trimmedPath || options.editorAppCache.has(trimmedPath) || options.editorAppPending.has(trimmedPath)) {
        return;
    }

    const userAgent = navigator.userAgent.toLowerCase();
    if (!userAgent.includes('mac')) {
        return;
    }

    options.editorAppPending.add(trimmedPath);
    try {
        const detectCommand = `osascript -e ${shellQuote(`set appAlias to default application of (info for POSIX file "${trimmedPath.replace(/"/g, '\\"')}")
return (name of (info for appAlias)) & linefeed & POSIX path of appAlias`)}`;
        const detectResult = await options.callTool?.('start_process', {
            command: detectCommand,
            timeout_ms: 12000,
        });
        const text = options.extractToolText(detectResult) ?? '';
        if (!text || text.toLowerCase().includes('error') || text.toLowerCase().includes('execution')) {
            return;
        }
        const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
        const appName = lines[lines.length - 2]?.replace(/\.app$/i, '') ?? '';
        const appPath = lines[lines.length - 1] ?? '';
        if (appName && appPath.startsWith('/')) {
            options.editorAppCache.set(trimmedPath, {
                appName,
                appPath,
            });
            options.onDetected?.();
        }
    } catch {
        // Fall back to generic editor label.
    } finally {
        options.editorAppPending.delete(trimmedPath);
    }
}

export function renderMarkdownEditorAppIcon(): string {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z"/></svg>';
}
