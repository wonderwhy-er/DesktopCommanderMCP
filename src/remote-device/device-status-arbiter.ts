/**
 * Single writer for the device's mcp_devices online/offline status.
 *
 * The device has two independent health signals — the Supabase Realtime
 * channel (server connectivity) and the local Desktop Commander child
 * (execution capability) — and previously each wrote status directly.
 * Independent writers contradict each other: a channel resubscribe used to
 * mark the device online while the local child was dead, advertising a device
 * that fails every routed call.
 *
 * The arbiter owns the truth: online iff BOTH signals are healthy, written
 * only on transitions — so retry storms that re-report an unchanged state
 * (e.g. repeated TIMED_OUT during a reconnect loop) produce zero extra
 * PATCHes to mcp_devices.
 */
export type DeviceHealthPart = 'channel' | 'child';

export class DeviceStatusArbiter {
    // The channel is assumed healthy until it reports otherwise: channel setup
    // completes before supervision starts reporting, and the first
    // CHANNEL_ERROR / TIMED_OUT / CLOSED flips it. The child must prove itself.
    private parts: Record<DeviceHealthPart, boolean> = { channel: true, child: false };
    // Devices register as offline; that is the last known persisted state.
    private lastWritten: 'online' | 'offline' | null = 'offline';
    private writeChain: Promise<void> = Promise.resolve();
    private readonly write: (status: 'online' | 'offline') => Promise<void>;

    constructor(options: { write: (status: 'online' | 'offline') => Promise<void> }) {
        this.write = options.write;
    }

    get status(): 'online' | 'offline' {
        return this.parts.channel && this.parts.child ? 'online' : 'offline';
    }

    report(part: DeviceHealthPart, ready: boolean) {
        this.parts[part] = ready;
        this.maybeWrite(false);
    }

    /**
     * Force-write the current status. Needed once after registration: reports
     * that arrive before a deviceId exists have their writes dropped by the
     * device's write callback, so the persisted state must be brought up to
     * date as soon as writes can succeed.
     */
    sync() {
        this.maybeWrite(true);
    }

    private maybeWrite(force: boolean) {
        const status = this.status;
        if (!force && status === this.lastWritten) return;
        this.lastWritten = status;
        // Serialize writes so offline→online in quick succession lands in order.
        this.writeChain = this.writeChain
            .then(() => this.write(status))
            .catch((error: any) =>
                console.error(`Failed to write device status '${status}':`, error?.message ?? error));
    }
}
