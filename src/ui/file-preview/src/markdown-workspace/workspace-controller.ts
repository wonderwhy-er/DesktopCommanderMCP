export interface ReadRange {
    fromLine: number;
    toLine: number;
    totalLines: number;
    isPartial: boolean;
}

export function stripReadStatusLine(content: string): string {
    return content.replace(/^\[Reading [^\]]+\]\r?\n(?:\r?\n)?/, '');
}

export function parseReadRange(content: string): ReadRange | undefined {
    const match = content.match(/^\[Reading (\d+) lines from (?:line )?(\d+|start) \(total: (\d+) lines/);
    if (!match) {
        return undefined;
    }

    const count = Number.parseInt(match[1], 10);
    const fromLine = match[2] === 'start' ? 1 : Number.parseInt(match[2], 10);
    const totalLines = Number.parseInt(match[3], 10);
    return {
        fromLine,
        toLine: fromLine + count - 1,
        totalLines,
        isPartial: count < totalLines,
    };
}

export function getMarkdownEditAvailability(options: {
    content: string;
}): { canEdit: true } | { canEdit: false; reason: string } {
    const readRange = parseReadRange(options.content);
    if (readRange?.isPartial) {
        return {
            canEdit: false,
            reason: 'Load the full document before editing.',
        };
    }

    return { canEdit: true };
}

export function getMarkdownFullscreenAvailability(options: {
    availableDisplayModes?: string[];
}): { canFullscreen: true } | { canFullscreen: false; reason: string } {
    if (!options.availableDisplayModes?.includes('fullscreen')) {
        return {
            canFullscreen: false,
            reason: 'Fullscreen editing is unavailable in this host.',
        };
    }

    return { canFullscreen: true };
}

export function shouldAutoLoadMarkdownOnEnterFullscreen(content: string): boolean {
    return parseReadRange(content)?.isPartial === true;
}
