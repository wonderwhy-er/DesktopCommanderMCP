export interface ReadRange {
    fromLine: number;
    toLine: number;
    totalLines: number;
    isPartial: boolean;
    /** 0-based offset for read_file calls. "from start" → 0, "from line N" → N. */
    readOffset: number;
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
    const isFromStart = match[2] === 'start';
    const readOffset = isFromStart ? 0 : Number.parseInt(match[2], 10);
    const fromLine = isFromStart ? 1 : readOffset;
    const totalLines = Number.parseInt(match[3], 10);
    return {
        fromLine,
        toLine: fromLine + count - 1,
        totalLines,
        isPartial: count < totalLines,
        readOffset,
    };
}

export function getDocumentFullscreenAvailability(options: {
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

export function shouldAutoLoadDocumentOnEnterFullscreen(content: string): boolean {
    return parseReadRange(content)?.isPartial === true;
}
