import { MCPDevice, getRemoteDeviceConfigPath, logoutRemoteDevice } from '../remote-device/device.js';
import os from 'os';
import { captureRemote } from '../utils/capture.js';
import { startDeviceLog } from '../remote-device/diagnostics/device-log.js';
import { startTerminalTimestamps } from '../utils/terminal-timestamps.js';

const BLUE = '\x1b[34m';
const RESET = '\x1b[0m';

function printRemoteHeader() {
    console.log();
    console.log(`${BLUE}██████╗ ███████╗███████╗██╗  ██╗████████╗ ██████╗ ██████╗     ██████╗ ██████╗ ███╗   ███╗███╗   ███╗ █████╗ ███╗   ██╗██████╗ ███████╗██████╗${RESET}`);
    console.log(`${BLUE}██╔══██╗██╔════╝██╔════╝██║ ██╔╝╚══██╔══╝██╔═══██╗██╔══██╗   ██╔════╝██╔═══██╗████╗ ████║████╗ ████║██╔══██╗████╗  ██║██╔══██╗██╔════╝██╔══██╗${RESET}`);
    console.log(`${BLUE}██║  ██║█████╗  ███████╗█████╔╝    ██║   ██║   ██║██████╔╝   ██║     ██║   ██║██╔████╔██║██╔████╔██║███████║██╔██╗ ██║██║  ██║█████╗  ██████╔╝${RESET}`);
    console.log(`${BLUE}██║  ██║██╔══╝  ╚════██║██╔═██╗    ██║   ██║   ██║██╔═══╝    ██║     ██║   ██║██║╚██╔╝██║██║╚██╔╝██║██╔══██║██║╚██╗██║██║  ██║██╔══╝  ██╔══██╗${RESET}`);
    console.log(`${BLUE}██████╔╝███████╗███████║██║  ██╗   ██║   ╚██████╔╝██║        ╚██████╗╚██████╔╝██║ ╚═╝ ██║██║ ╚═╝ ██║██║  ██║██║ ╚████║██████╔╝███████╗██║  ██║${RESET}`);
    console.log(`${BLUE}╚═════╝ ╚══════╝╚══════╝╚═╝  ╚═╝   ╚═╝    ╚═════╝ ╚═╝         ╚═════╝ ╚═════╝ ╚═╝     ╚═╝╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═════╝ ╚══════╝╚═╝  ╚═╝${RESET}`);
    console.log();
    console.log(`${BLUE}🌐 Remote Connection${RESET}`);
    console.log();
}

export async function runRemote() {
    startTerminalTimestamps();
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
        console.log(`Desktop Commander Remote MCP device

Usage:
  desktop-commander remote [options]

Options:
  --logout              Revoke this device and remove saved credentials
  --report              Save a diagnostics zip for support, send it, and exit
                        (the device doesn't start and nothing signs in)
  --no-upload           With --report: only save the zip, don't send it
  --no-persist-session  Do not reuse or save authentication for this run
  --disable-no-sleep    Do not prevent sleep while the remote device is running
  --debug                Enable verbose debug logging
  -h, --help             Show this help

Examples:
  npx @wonderwhy-er/desktop-commander@latest remote
  npx @wonderwhy-er/desktop-commander@latest remote --debug
  npx @wonderwhy-er/desktop-commander@latest remote --logout
  npx @wonderwhy-er/desktop-commander@latest remote --report

Note:
  --logout requires the backend to confirm device and MQTT certificate revocation.
  Saved credentials are kept on failure so you can retry. After successful logout,
  the next start requires pairing this computer again.`);
        return;
    }
    if (process.argv.includes('--logout')) {
        const configPath = getRemoteDeviceConfigPath();
        try {
            await logoutRemoteDevice(configPath);
            console.log('🔓 Logged out. Saved device and MQTT credentials were removed.');
            console.log(`   ${configPath}`);
            console.log('   Start remote again to pair this computer from scratch.');
        } catch (error: any) {
            console.error('❌ Logout did not complete:', error.message);
            process.exitCode = 1;
        }
        return;
    }
    if (process.argv.includes('--report')) {
        // Before the device: the report works when sign-in is broken, and never opens it
        const { runReport } = await import('../remote-device/diagnostics/report.js');
        await runReport();
        return;
    }
    printRemoteHeader();

    // --persist-session is kept as an accepted no-op so existing invocations
    // and docs keep working; --no-persist-session opts back out.
    const persistSession = !process.argv.includes('--no-persist-session');
    if (!persistSession) {
        console.log('🔓 Session persistence disabled — re-authorization required on every start');
    }
    const disableNoSleep = process.argv.includes('--disable-no-sleep');
    const verbose = process.argv.includes('--debug');
    console.debug('[DEBUG] Verbose mode: ', verbose);
    // Override console.debug based on verbose flag
    // When --debug is not provided, console.debug becomes a no-op
    if (!verbose) {
        console.debug = () => { };
    }
    // The device's status history for `remote --report`. Wraps the console as
    // it is now, so the terminal stays the same, but debug status lines are
    // kept even without --debug.
    startDeviceLog();

    console.debug('[DEBUG] Platform:', os.platform());
    await captureRemote('remote_device_command_started', {
        node_version: process.version,
        persist_session: persistSession,
    });

    // Start caffeinate on macOS (unless disabled)
    // Caffeinate will monitor this process and automatically exit when it terminates
    if (!disableNoSleep && os.platform() === 'darwin') {
        try {
            console.debug('[DEBUG] Start caffeinate', process.pid);
            const { default: caffeinate } = await import('caffeinate');
            caffeinate({ pid: process.pid });
            console.log('☕ No sleep mode enabled');
        } catch (error) {
            console.warn('⚠️ Failed to start caffeinate:', error);
        }
    }

    const device = new MCPDevice({ persistSession });
    await device.start();
}
