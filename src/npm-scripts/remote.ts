import { MCPDevice } from '../remote-device/device.js';

export async function runRemote() {
    const persistSession = process.argv.includes('--persist-session');
    const device = new MCPDevice({ persistSession });
    await device.start();
}
