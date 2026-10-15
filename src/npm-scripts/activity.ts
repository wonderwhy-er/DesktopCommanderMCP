import { ActivityView } from '../activity/activity.js';
import { activitySocketPath, createActivityMonitor } from '../activity/channel.js';

export async function runActivityMonitor(): Promise<void> {
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
        process.stdout.write('Usage: desktop-commander activity\nShows local MCP tool activity; does not modify any Remote Device.\n');
        return;
    }

    const view = new ActivityView();
    // Bind the socket before taking over the terminal, so a startup error does
    // not leave the user's terminal in an altered state.
    const monitor = await createActivityMonitor(view);
    const tty = !!process.stdout.isTTY && process.env.DC_ACTIVITY_UI !== 'off' && !process.env.NO_COLOR;
    const redraw = () => view.refresh();
    let signalHandler: (() => void) | undefined;

    try {
        if (tty) {
            process.stdout.write('\x1b[?1049h\x1b[?25l'); // Alternate screen and hidden cursor.
            process.stdout.on('resize', redraw);
        }
        view.announce({ phase: 'progress', message: 'Yerel MCP izleme ekranı hazır; çağrılar bekleniyor' });
        if (!tty) process.stdout.write('Monitor socket: ' + activitySocketPath() + '\n');

        await new Promise<void>((resolve) => {
            signalHandler = resolve;
            process.once('SIGINT', signalHandler);
            process.once('SIGTERM', signalHandler);
            process.once('SIGHUP', signalHandler);
        });
    } finally {
        if (signalHandler) {
            process.off('SIGINT', signalHandler);
            process.off('SIGTERM', signalHandler);
            process.off('SIGHUP', signalHandler);
        }
        process.stdout.off('resize', redraw);
        if (tty) process.stdout.write('\x1b[?25h\x1b[?1049l');
        await monitor.close();
    }
}
