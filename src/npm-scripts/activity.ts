import { ActivityView } from '../activity/activity.js';
import { activitySocketPath, createActivityMonitor } from '../activity/channel.js';

export async function runActivityMonitor(): Promise<void> {
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
        process.stdout.write('Usage: desktop-commander activity\nShows activity from this fork of the local MCP server. Does not start or modify a remote device.\n');
        return;
    }
    const view = new ActivityView();
    const monitor = await createActivityMonitor(view);
    view.announce({ phase: 'progress', message: 'Yerel MCP izleme ekranı hazır; çağrılar bekleniyor' });
    if (!process.stdout.isTTY) process.stdout.write('Monitor socket: ' + activitySocketPath() + '\n');

    await new Promise<void>((resolve) => {
        const finish = () => resolve();
        process.once('SIGINT', finish);
        process.once('SIGTERM', finish);
    });
    await monitor.close();
}
