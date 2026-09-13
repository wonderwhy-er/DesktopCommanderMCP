import { MCPDevice, getRemoteDeviceConfigPath } from '../remote-device/device.js';
import fs from 'fs/promises';
import os from 'os';

export async function runRemote() {
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
        console.log(`Desktop Commander Remote MCP device

Usage:
  desktop-commander remote [options]

Options:
  --logout              Remove saved local Remote MCP credentials and exit
  --no-persist-session  Do not reuse or save authentication for this run
  --disable-no-sleep    Do not prevent sleep while the remote device is running
  --debug                Enable verbose debug logging
  -h, --help             Show this help`);
        return;
    }
    if (process.argv.includes('--logout')) {
        const configPath = getRemoteDeviceConfigPath();
        try {
            await fs.rm(configPath, { force: true });
            console.log('🔓 Logged out locally. Saved Remote MCP device credentials were removed.');
            console.log(`   ${configPath}`);
        } catch (error: any) {
            console.error('❌ Failed to remove saved Remote MCP credentials:', error.message);
            process.exitCode = 1;
        }
        return;
    }
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

    console.debug('[DEBUG] Platform:', os.platform());

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
