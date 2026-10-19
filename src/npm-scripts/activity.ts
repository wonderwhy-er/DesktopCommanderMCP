import { ActivityView } from '../activity/activity.js';
import { FrameCoalescer } from '../activity/frame-coalescer.js';
import { activitySocketPath, createActivityMonitor } from '../activity/channel.js';

export async function runActivityMonitor(): Promise<void> {
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
        process.stdout.write('Usage: desktop-commander activity\nLocal, read-only MCP activity monitor. Press Q to quit.\n');
        return;
    }

    const tty = !!process.stdout.isTTY && process.env.DC_ACTIVITY_UI !== 'off';
    const frames = tty ? new FrameCoalescer(process.stdout) : null;
    const screen = frames ? {
        isTTY: true,
        get columns() { return process.stdout.columns; },
        get rows() { return process.stdout.rows; },
        write: (data: string) => frames.write(data),
    } : process.stdout;
    const view = new ActivityView(screen);
    const monitor = await createActivityMonitor(view);
    let finish: (() => void) | undefined;
    let onInput: ((data: Buffer) => void) | undefined;
    let rawChanged = false;
    let refreshTimer: NodeJS.Timeout | undefined;
    const initialRawMode = !!process.stdin.isRaw;
    const redraw = () => view.refresh();

    try {
        if (tty) {
            if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
                process.stdin.setRawMode(true); // Suppress literal ^[[A/^[[B echo.
                rawChanged = true;
                process.stdin.resume();
            }
            process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h');
            process.stdout.on('resize', redraw);
            refreshTimer = setInterval(() => {
                if (view.getTotals().active > 0) view.refresh();
            }, 500);
            refreshTimer.unref();
        } else {
            process.stdout.write('Monitor socket: ' + activitySocketPath() + '\n');
        }

        await new Promise<void>((resolve) => {
            finish = resolve;
            if (tty && rawChanged) {
                onInput = (chunk: Buffer) => { if (view.handleInput(chunk.toString('utf8'))) resolve(); };
                process.stdin.on('data', onInput);
            }
            process.once('SIGINT', resolve);
            process.once('SIGTERM', resolve);
            process.once('SIGHUP', resolve);
            if (tty) view.refresh();
        });
    } finally {
        if (finish) {
            process.off('SIGINT', finish);
            process.off('SIGTERM', finish);
            process.off('SIGHUP', finish);
        }
        if (refreshTimer) clearInterval(refreshTimer);
        if (onInput) process.stdin.off('data', onInput);
        process.stdout.off('resize', redraw);
        frames?.close(); // No queued screen writes after terminal restoration.
        if (tty) process.stdout.write('\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l');
        if (rawChanged) {
            process.stdin.setRawMode(initialRawMode);
            process.stdin.pause();
        }
        await monitor.close();
    }
}
