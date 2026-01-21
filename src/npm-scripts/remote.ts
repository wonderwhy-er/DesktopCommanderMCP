import { MCPDevice } from '../remote-device/device.js';
import os from 'os';

export async function runRemote() {
    const persistSession = process.argv.includes('--persist-session');
    const disableNoSleep = process.argv.includes('--disable-no-sleep');

    // Start caffeinate on macOS (unless disabled)
    // Caffeinate will monitor this process and automatically exit when it terminates
    if (!disableNoSleep && os.platform() === 'darwin') {
        try {
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
