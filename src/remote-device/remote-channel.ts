import { createClient, SupabaseClient, Session, UserResponse, User, RealtimeChannel } from '@supabase/supabase-js';
import { captureRemote } from '../utils/capture.js';
import { VERSION } from '../version.js';

const NUL_CHAR = String.fromCharCode(0);
const NUL_RE = new RegExp(NUL_CHAR, 'g');

/**
 * Recursively strip real NUL characters (U+0000) from strings and object keys.
 * Postgres cannot store a NUL in jsonb OR text and rejects the whole write with
 * 22P05, which strands the call at 'executing' until the 5-min timeout.
 *
 * Walks the structure instead of round-tripping through JSON: an earlier
 * serialize-and-regex version matched the ESCAPE TEXT rather than the character,
 * so legitimate content containing the six literal chars backslash-u-0-0-0-0
 * (e.g. reading a source file with that escape in it) was silently corrupted,
 * and a doubled-backslash form produced invalid JSON that threw. Both cases are
 * covered by tests in test/test-strip-null-bytes.js.
 */
export function stripNullBytes<T>(value: T): T {
    if (typeof value === 'string') {
        return (value.includes(NUL_CHAR) ? value.replace(NUL_RE, '') : value) as T;
    }
    if (Array.isArray(value)) {
        return value.map((item) => stripNullBytes(item)) as T;
    }
    if (value && typeof value === 'object') {
        // Plain objects only — leave Date/Buffer/etc. untouched.
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) return value;
        const out: Record<string, any> = {};
        for (const [k, v] of Object.entries(value as Record<string, any>)) {
            out[k.includes(NUL_CHAR) ? k.replace(NUL_RE, '') : k] = stripNullBytes(v);
        }
        return out as T;
    }
    return value;
}


export interface AuthSession {
    access_token: string;
    refresh_token: string | null;
    device_id?: string;
}

interface DeviceData {
    user_id: string;
    device_name: string;
    capabilities: any;
    status: string;
    last_seen: string;
}

// Bookkeeping cadence for the durable last_seen column ONCE the broadcast
// transport is proven. Liveness is then carried by Presence (websocket-level,
// flips in seconds), so this write is not the live signal — but it IS the
// server's fallback whenever presence is unavailable, which is why it cannot be
// slow. Paired with DEVICE_OFFLINE_TIMEOUT_CAPABLE_MS = 15 min (3 missed
// writes); the full rationale for that pairing, and the list of states that
// reach it, lives on that constant in remote-dc-mcp/src/server/constants.ts.
const CAPABLE_HEARTBEAT_INTERVAL = 5 * 60 * 1000;
// Cadence while this device is in the LEGACY tier — i.e. whenever
// transport_broadcast_v1 is not currently advertised, i.e. whenever presence
// has not (yet) been proven. MUST stay well inside the server's legacy sweep
// threshold (DEVICE_OFFLINE_TIMEOUT_MS = 45s), because the server tiers the
// sweep on the CAPABILITY FLAG, not on the app version: a device without the
// flag is judged by the 45s rule no matter how new its build is.
//
// Getting this wrong is not a slow degradation, it is a blackout: on the slow
// capable cadence a device that cannot prove the private channel (008 not applied,
// an authz hiccup, exhausted track() retries) is swept offline ~45s after
// registering and dispatch then throws "No devices available" forever — even
// though its INDEPENDENT legacy postgres_changes channel is joined and would
// deliver calls perfectly. That blackout is exactly what the independent
// legacyChannel exists to prevent, so the two must be kept in step.
const LEGACY_HEARTBEAT_INTERVAL = 15 * 1000;
// Cap the channel-rebuild portion of a recreate so a hung await can't pin the
// re-entrancy guard true (which would silently disable the connection watchdog).
// NOTE: the jittered backoff sleep runs BEFORE this cap and inside the guard, so
// the total window in which checkConnectionHealth is a no-op is
// backoff (<=45s) + RECREATE_TIMEOUT_MS — bounded at ~75s, not 30s.
// Must exceed createChannel()'s worst case, which now includes
// trackPresenceWithRetry: 3 track() pushes at realtime-js's 10s DEFAULT_TIMEOUT
// plus 0.5s+1s backoff = ~31.5s. At the old 30s these two constants were in
// silent conflict — any recreate where presence never acked ALWAYS timed out.
const RECREATE_TIMEOUT_MS = 45000;
// Max time the channel may sit CONTINUOUSLY in 'joining' before we force a recreate.
// 'joining' is normally healthy (we let realtime-js's rejoin backoff converge), but on a
// HALF-OPEN socket (readyState OPEN yet dead) realtime-js parks the channel in 'joining'
// forever and never reconnects the socket — the device then wedges offline silently with
// no recreate firing. realtime-js's join push times out in ~10s, so a genuine join
// resolves/errors well within this window; 3 health ticks of unbroken 'joining' means the
// state machine has stalled and only a fresh socket (via recreate) recovers it.
const JOINING_WEDGE_TIMEOUT_MS = 30000;
// Consecutive failed channel recreates after which this device WITHDRAWS
// transport_broadcast_v1.
//
// This is load-bearing, not tidiness. For a flagged device the server treats
// absent Presence as AUTHORITATIVE offline and applies that overlay BEFORE
// selection — it outranks the `status` column entirely. So a device that keeps
// the flag while unable to join the private channel is undispatchable no matter
// how healthy its legacy channel is, and no matter how fresh its last_seen.
// Withdrawing the promise is what drops it back to a tier the server will still
// route to (see setTransportCapable / the rollback runbook's stage rules).
//
// The withdrawal deliberately does NOT hang off CHANNEL_ERROR: realtime-js
// re-fires that on every failed rejoin, so a momentary blip would flap the
// capability and its DB write. Gate on sustained failure instead — 3 recreates
// is ~30s given the jittered backoff. A later successful track() re-advertises
// automatically.
//
// DO NOT LOWER THIS TO 2. Ordinary half-open recovery legitimately costs two
// attempts: removeChannel() disconnects the socket when the last channel leaves,
// and realtime-js then refuses to reconnect for ~100ms while _connectionState is
// 'disconnecting', so the FIRST recreate's join pushes are buffered and burn the
// full 10s join timeout — the second dials the fresh socket and succeeds. At 2,
// every routine wifi drop would withdraw the capability and churn the DB.
const TRANSPORT_WITHDRAW_AFTER_ATTEMPTS = 3;
// Bound on the capability-withdrawal write. It runs in recreateChannel()'s catch
// block, outside RECREATE_TIMEOUT_MS's reach, so it needs its own cap.
const CAPABILITY_WRITE_TIMEOUT_MS = 5000;
// Bound on the shutdown path's session fetch. See setOffline() — auth.getSession()
// can block on a token refresh, and this runs against device.ts's 5s force-exit.
const OFFLINE_SESSION_TIMEOUT_MS = 500;

export class RemoteChannel {
    private client: SupabaseClient | null = null;
    private channel: RealtimeChannel | null = null;
    /**
     * TRANSITION ONLY (removed at the flip): the legacy postgres_changes
     * listener lives on its OWN public channel, deliberately NOT on the private
     * user channel. It is the safety net for the broadcast transport, so it
     * must not share a failure mode with it — if it rode the private channel,
     * an 008 policy problem or any private-channel auth failure would take out
     * BOTH transports at once and the device would go completely dark instead
     * of degrading to the old path. Costs one extra channel per device (the
     * device's own connection carries 2, far under the 100/connection quota).
     */
    private legacyChannel: RealtimeChannel | null = null;
    private heartbeatInterval: NodeJS.Timeout | null = null;
    private connectionCheckInterval: NodeJS.Timeout | null = null;
    // Device whose last_seen the heartbeat timer maintains; null = stopped.
    // Held so scheduleHeartbeat() can re-arm itself without re-plumbing the id.
    private heartbeatDeviceId: string | null = null;
    // Single-slot queue keeping concurrent `status` PATCHes in order.
    private statusWriteChain: Promise<void> = Promise.resolve();
    // Tokens from the last successful setSession / TOKEN_REFRESHED, so the
    // shutdown path never has to wait on auth.getSession(). See setOffline().
    private lastKnownSession: { access_token: string; refresh_token: string | null } | null = null;
    // Set once unsubscribe() starts: suppresses further reachability-driven
    // status writes so they cannot land after setOffline()'s durable write.
    private shuttingDown = false;


    // Store subscription parameters for channel recreation
    private deviceId: string | null = null;
    private deviceName: string | null = null;
    private onToolCall: ((payload: any) => void) | null = null;
    // Guard so setSession being called twice can't stack auth listeners.
    private authListenerRegistered = false;
    // False when presence publishing failed on a channel that is otherwise
    // healthy — the health check re-tries, since nothing else would (a joined
    // channel never re-fires SUBSCRIBED) and the server would keep reporting
    // this device offline.
    private presenceTracked = false;
    // Last capability value written to the DB (null = not yet written), so the
    // flag isn't re-written on every reconnect.
    private transportCapableWritten: boolean | null = null;
    // Re-entrancy guard for the presence self-heal: on a wedged socket each
    // track() buffers for the full 10s push timeout, so unguarded 10s health
    // ticks would stack pending pushes.
    private isTrackingPresence = false;

    // Track last device status to prevent duplicate log messages
    private lastDeviceStatus: 'online' | 'offline' = 'offline';

    // Track last channel state for debug logging
    private lastChannelState: string | null = null;

    // Reconnect diagnostics + guard (see connState() / recreateChannel())
    private reconnectAttempt = 0;        // recreateChannel() attempts since last success
    private isRecreatingChannel = false; // a recreate is in flight (re-entrancy guard)
    private joiningSince: number | null = null; // ts the channel entered an unbroken 'joining' run; null when not joining

    private _user: User | null = null;
    get user(): User | null { return this._user; }


    initialize(url: string, key: string): void {
        this.client = createClient(url, key);
    }

    async setSession(session: AuthSession): Promise<{ error: any }> {
        if (!this.client) throw new Error('Client not initialized');
        console.debug('[DEBUG] RemoteChannel.setSession() called, has refresh_token:', !!session.refresh_token);
        const { error } = await this.client.auth.setSession({
            access_token: session.access_token,
            refresh_token: session.refresh_token || ''
        });

        if (error) {
            console.error('[DEBUG] Failed to set session:', error.message);
            await captureRemote('remote_channel_set_session_error', { error });
            return { error };
        }

        // Get user info
        const { data: { user }, error: userError } = await this.client.auth.getUser();
        if (userError) {
            console.error('[DEBUG] Failed to get user:', userError.message);
            await captureRemote('remote_channel_get_user_error', { error: userError });
            throw userError;
        }

        if (!user) {
            const noUserError = new Error('No user returned after setSession');
            console.error('[DEBUG] No user returned:', noUserError.message);
            await captureRemote('remote_channel_get_user_empty', {});
            throw noUserError;
        }

        this._user = user;
        console.debug('[DEBUG] Session set successfully, user:', user.email);

        // Private channels authorize with the user JWT at join time. supabase-js
        // generally forwards auth to realtime itself; this is defensive and must
        // push the CURRENT session token, not the one we were handed:
        // auth.setSession() refreshes an expired token internally (device asleep
        // >1h with --persist-session), and pushing the stale parameter here would
        // overwrite the fresh token realtime already had — every private-channel
        // join then fails until the next refresh (~50 min deaf).
        const { data: { session: currentSession } } = await this.client.auth.getSession();
        const realtimeToken = currentSession?.access_token ?? session.access_token;
        this.client.realtime.setAuth(realtimeToken);
        // Cache tokens for the shutdown path: setOffline() must not depend on a
        // getSession() that can block on a token refresh while device.ts's 5s
        // force-exit is running down (see setOffline).
        this.lastKnownSession = {
            access_token: realtimeToken,
            refresh_token: currentSession?.refresh_token ?? session.refresh_token ?? null,
        };
        console.debug('[DEBUG] Realtime socket authorized with current session JWT');
        if (!this.authListenerRegistered) {
            this.authListenerRegistered = true;
            this.client.auth.onAuthStateChange((event, newSession) => {
                if (event === 'TOKEN_REFRESHED' && newSession?.access_token && this.client) {
                    console.debug('[DEBUG] Token refreshed — re-authorizing realtime socket');
                    this.client.realtime.setAuth(newSession.access_token);
                    this.lastKnownSession = {
                        access_token: newSession.access_token,
                        refresh_token: newSession.refresh_token ?? this.lastKnownSession?.refresh_token ?? null,
                    };
                }
            });
        }

        return { error };
    }

    async getSession(): Promise<{ data: { session: Session | null }; error: any }> {
        if (!this.client) throw new Error('Client not initialized');
        return await this.client.auth.getSession();
    }

    async findDevice(deviceId: string) {
        if (!this.client) throw new Error('Client not initialized');
        const { data, error } = await this.client
            .from('mcp_devices')
            .select('id, device_name')
            .eq('id', deviceId)
            .eq('user_id', this.user?.id)
            .maybeSingle();

        if (error) {
            console.error('[DEBUG] Failed to find device:', error.message);
            await captureRemote('remote_channel_find_device_error', { error });
            throw error;
        }
        return data;
    }

    async updateDevice(deviceId: string, updates: any) {
        if (!this.client) throw new Error('Client not initialized');
        const { data, error } = await this.client
            .from('mcp_devices')
            .update(updates)
            .eq('id', deviceId)
            .select();

        if (error) {
            console.error('[DEBUG] Failed to update device:', error.message);
            await captureRemote('remote_channel_update_device_error', { error });
        } else {
            console.debug('[DEBUG] Device updated successfully');
        }
        return { data, error };
    }

    async createDevice(deviceData: DeviceData) {
        if (!this.client) throw new Error('Client not initialized');
        const { data, error } = await this.client
            .from('mcp_devices')
            .insert(deviceData)
            .select()
            .single();

        if (error) {
            console.error('[DEBUG] Failed to create device:', error.message);
            await captureRemote('remote_channel_create_device_error', { error });
            throw error;
        }
        console.debug('[DEBUG] Device created successfully');
        return { data, error };
    }

    async registerDevice(capabilities: any, currentDeviceId: string | undefined, deviceName: string, onToolCall: (payload: any) => void): Promise<void> {

        console.debug('[DEBUG] RemoteChannel.registerDevice() called, deviceId:', currentDeviceId);

        let existingDevice = null;

        if (currentDeviceId && this.user) {
            console.debug('[DEBUG] Finding existing device...');
            existingDevice = await this.findDevice(currentDeviceId);
            console.debug('[DEBUG] Existing device found:', !!existingDevice);
        }

        if (existingDevice) {
            console.debug('[DEBUG] Updating device status to online');
            // NOTE: transport_broadcast_v1 is deliberately NOT set here. The flag
            // is a promise the device may not be able to keep, and the server
            // treats it as binding: for a flagged device, absent presence is
            // authoritative offline (overlayPresence) and dispatch then throws
            // "No devices available". Advertising it before the private channel
            // is proven means an 008/authz/Realtime problem takes the device dark
            // even though its legacy postgres_changes channel is perfectly
            // healthy — the exact outcome the independent legacyChannel exists to
            // prevent. It is written only after SUBSCRIBED + a successful presence
            // track (see markTransportCapable), and cleared when presence
            // definitively fails, so a device that cannot deliver on the promise
            // simply reports itself legacy and stays dispatchable.
            await this.updateDevice(existingDevice.id, {
                status: 'online',
                last_seen: new Date().toISOString(),
                capabilities: this.capabilitiesPayload(false),
                device_name: deviceName
            });

            // Store parameters for channel recreation
            this.deviceId = existingDevice.id;
            this.deviceName = deviceName;
            this.onToolCall = onToolCall;

            console.debug(`⏳ Subscribing to tool call channel...`);

            // Create and subscribe to the channel
            console.debug('[DEBUG] Calling createChannel()');

            // ! Ignore silently in Initialization to reconnect after
            // Legacy postgres_changes listener on its own public channel — the
            // independent safety net for the doorbell transport (see legacyChannel).
            this.createLegacyChannel();

            await this.createChannel().catch((error) => {
                console.debug(`[DEBUG] Failed to create channel, will retry after socket reconnect: ${error?.message || error} — ${this.connState()}`);
            });

        } else {
            console.error(`   - ❌ Device not found: ${currentDeviceId}`);
            await captureRemote('remote_channel_register_device_error', { error: 'Device not found', deviceId: currentDeviceId });
            throw new Error(`Device not found: ${currentDeviceId}`);
        }
    }

    /**
     * Publish this device's presence, retrying a non-'ok' result. track()
     * RESOLVES with 'ok' | 'error' | 'timed out' rather than rejecting, and a
     * silent failure is expensive: the server treats absent presence as
     * authoritative offline, so one lost track makes a fully working device
     * undispatchable until the channel next bounces. `presenceTracked` lets the
     * health check re-try later if every attempt here fails.
     */
    private async trackPresenceWithRetry(recovered: number, attempts = 3): Promise<void> {
        if (this.isTrackingPresence) return; // never stack pushes on a wedged socket
        this.isTrackingPresence = true;
        try {
            await this.trackPresenceInner(recovered, attempts);
        } finally {
            this.isTrackingPresence = false;
        }
    }

    private async trackPresenceInner(recovered: number, attempts: number): Promise<void> {
        for (let attempt = 1; attempt <= attempts; attempt++) {
            if (!this.channel || this.channel.state !== 'joined') return;
            let status: string;
            try {
                status = await this.channel.track({
                    device_id: this.deviceId,
                    device_name: this.deviceName,
                    app_version: VERSION,
                    platform: process.platform
                });
            } catch (trackErr: any) {
                status = `threw: ${trackErr?.message}`;
            }

            if (status === 'ok') {
                this.presenceTracked = true;
                console.log(`👋 Presence tracked (device ${this.deviceId} visible as online)`);
                // recoveredAfterAttempts, not "attempt": this is how many
                // reconnect attempts preceded the join that carried this track
                // (0 on a first join AND on the health-check self-heal path).
                captureRemote('remote_channel_presence_tracked', { recoveredAfterAttempts: recovered }).catch(() => { });
                // Transport is proven end-to-end (channel joined AND presence
                // published) — only now is it safe to let the server route us
                // over broadcast and treat our presence as authoritative.
                await this.setTransportCapable(true);
                return;
            }

            console.error(`❌ Presence track not acknowledged (${status}) — attempt ${attempt}/${attempts}`);
            if (attempt < attempts) await this.sleep(500 * attempt);
        }

        this.presenceTracked = false;
        console.error('❌ Presence track failed after retries — reverting to the legacy transport tier');
        captureRemote('remote_channel_presence_track_error', { attempts }).catch(() => { });
        // Withdraw the promise: without presence the server cannot see us, and a
        // stale capability flag would make it refuse to dispatch entirely. Going
        // back to the legacy tier keeps the device usable over postgres_changes.
        await this.setTransportCapable(false);
    }

    /**
     * The complete `capabilities` JSONB value for this device. Built in ONE
     * place because every write REPLACES the whole column — a second literal
     * elsewhere would silently delete whatever key it forgot on the next
     * reconnect.
     */
    private capabilitiesPayload(broadcastCapable: boolean): Record<string, any> {
        return {
            app_version: VERSION,
            ...(broadcastCapable ? { transport_broadcast_v1: true } : {})
        };
    }

    /**
     * Advertise (or withdraw) the broadcast transport capability. The server
     * reads this flag to choose a transport AND to decide whether absent
     * presence means "offline" — so it must only ever be true while this device
     * can actually be reached that way.
     *
     * The flag also selects which tier of the server's offline sweep judges
     * this device (45s legacy vs 15min capable), so every change here MUST
     * re-arm the heartbeat at the matching cadence — otherwise withdrawing the
     * flag leaves the device in the 45s tier while it still heartbeats on the
     * slow capable cadence and the sweep blacks it out.
     */
    private async setTransportCapable(capable: boolean): Promise<void> {
        if (!this.client || !this.deviceId) return;
        if (this.transportCapableWritten === capable) return; // no redundant writes
        try {
            const capabilities = this.capabilitiesPayload(capable);
            const { error } = await this.client
                .from('mcp_devices')
                .update({ capabilities })
                .eq('id', this.deviceId);
            if (error) {
                console.error('[DEBUG] Failed to update transport capability:', error.message);
                return;
            }
            this.transportCapableWritten = capable;
            console.debug(`[DEBUG] Transport capability set to ${capable ? 'broadcast_v1' : 'legacy'}`);
            // Tier changed — move last_seen onto the cadence that tier's sweep
            // threshold expects (no-op if the heartbeat hasn't started yet).
            this.scheduleHeartbeat();
            // Dropping to the fast tier: the row was last written on the slow
            // capable cadence, so it can already be minutes old — i.e. ALREADY
            // past the 45s legacy threshold the device is now judged by. Write
            // once immediately rather than waiting out the new interval, which
            // would leave the device swept-offline in the meantime (and, on a
            // device flapping tiers faster than the interval, indefinitely,
            // since every re-arm restarts the countdown).
            if (!capable && this.heartbeatDeviceId) {
                this.updateHeartbeat(this.heartbeatDeviceId).catch(() => { /* logged inside */ });
            }
        } catch (error: any) {
            console.error('[DEBUG] Transport capability update threw:', error?.message);
        }
    }

    /**
     * Subscribe the legacy postgres_changes listener on its own PUBLIC channel.
     * Independent of the private user channel on purpose (see legacyChannel).
     * Best-effort: failures here are logged, never thrown — the doorbell path is
     * primary, and realtime-js rejoins this channel on its own.
     * Removed entirely at the flip (009), when postgres_changes stops firing.
     */
    private createLegacyChannel(): void {
        if (!this.client || !this.user?.id) return;
        try {
            this.legacyChannel = this.client
                .channel('device_tool_call_queue')
                .on(
                    'postgres_changes' as any,
                    {
                        event: 'INSERT',
                        schema: 'public',
                        table: 'mcp_remote_calls',
                        filter: `user_id=eq.${this.user.id}`
                    },
                    (payload: any) => {
                        console.debug('[DEBUG] Realtime event received, payload:', payload?.new?.id);
                        if (this.onToolCall) {
                            this.onToolCall(payload);
                        }
                    }
                )
                .subscribe((status: string) => {
                    console.debug(`[DEBUG] Legacy channel status: ${status}`);
                });
        } catch (error: any) {
            console.debug('[DEBUG] Legacy channel subscribe failed (doorbell path unaffected):', error?.message);
        }
    }

    /** Tear down the legacy channel (best effort). */
    private async removeLegacyChannel(): Promise<void> {
        if (!this.legacyChannel || !this.client) return;
        try {
            await this.client.removeChannel(this.legacyChannel);
        } catch { /* best effort */ }
        this.legacyChannel = null;
    }

    /**
     * Create and subscribe to the channel.
     * This is used for both initial subscription and recreation after socket reconnects.
     */
    private createChannel(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.client || !this.user?.id || !this.onToolCall || !this.deviceId) {
                // deviceId included deliberately: it is the presence KEY, and a
                // null key makes realtime assign a random one — the server's
                // lookup by device id then misses and the device is invisible
                // while every local signal says healthy.
                console.debug('[DEBUG] createChannel() failed - missing prerequisites');
                return reject(new Error('Client not initialized or missing subscription parameters'));
            }

            // Private per-user channel: carries the legacy postgres_changes
            // listener (kept until the fleet-wide flip), the new_call broadcast
            // doorbell, and this device's Presence (key = device id, so the
            // server and dashboard read liveness straight off presenceState()).
            const channelName = `user:${this.user.id}`;
            console.debug(`[DEBUG] Creating channel: ${channelName}`);
            this.channel = this.client.channel(channelName, {
                // ack: true — without it send() resolves 'ok' as soon as the frame
                // is written to the socket, so notifyResult's status check (and its
                // failure telemetry) could never fire. presence.enabled makes the
                // presence extension explicit rather than inferred.
                config: {
                    private: true,
                    broadcast: { ack: true },
                    // key is non-null: the guard above rejects when !deviceId,
                    // precisely because a null key makes realtime assign a
                    // random one and the server's lookup by device id misses.
                    presence: { key: this.deviceId, enabled: true }
                }
            })
                .on(
                    'broadcast',
                    { event: 'new_call' },
                    ({ payload }: any) => {
                        this.onDoorbell(payload).catch((e: any) => {
                            console.error('[DEBUG] Doorbell handling failed:', e?.message);
                        });
                    }
                )
                .subscribe((status: string, err: any) => {
                    // Debug: Log all subscription status events
                    console.debug(`[DEBUG] Channel subscription status: ${status}${err ? ' (error: ' + (err?.message || err) + ')' : ''} — ${this.connState()}`);

                    if (status === 'SUBSCRIBED') {
                        const recovered = this.reconnectAttempt;
                        this.reconnectAttempt = 0;
                        console.log(`✅ Channel subscribed${recovered > 0 ? ` (recovered after ${recovered} attempt${recovered === 1 ? '' : 's'})` : ''}`);
                        // Update device status on successful connection (queued, so
                        // it can't be overtaken by a teardown's status write).
                        this.queueStatusWrite('online');
                        // Announce presence — this IS the live "online" signal the
                        // server's dispatch check reads. A failed track leaves a
                        // perfectly healthy device invisible (server treats absent
                        // presence as authoritative offline → "No devices
                        // available"), so retry, and only resolve once it lands:
                        // resolving first would let registerDevice() print
                        // "Device ready" while the device is still undispatchable.
                        this.trackPresenceWithRetry(recovered)
                            .catch(() => { /* logged inside */ })
                            .finally(() => resolve());
                    } else if (status === 'CHANNEL_ERROR') {
                        // CHANNEL_ERROR is the only status carrying a real error message.
                        console.error(`❌ Channel error: ${err?.message || 'unknown'} — ${this.connState()}`);
                        this.presenceTracked = false;
                        this.syncReachabilityStatus();
                        // Single event: this fires on ordinary network faults too, so a
                        // separate "private join failed" alarm would be a 1:1 duplicate
                        // with no added specificity. Filter on the error text
                        // ("Unauthorized"/policy) to isolate an 008 misconfiguration.
                        captureRemote('remote_channel_subscription_error', { error: err?.message || 'Channel error' }).catch(() => { });
                        reject(err || new Error('Failed to initialize tool call channel subscription'));
                    } else if (status === 'TIMED_OUT') {
                        console.error(`⏱️ Channel subscription timed out, Reconnecting... — ${this.connState()}`);
                        this.syncReachabilityStatus();
                        captureRemote('remote_channel_subscription_timeout', { attempt: this.reconnectAttempt }).catch(() => { });
                        reject(new Error('Tool call channel subscription timed out'));
                    } else if (status === 'CLOSED') {
                        // Settle the promise so an in-flight recreateChannel() can't await
                        // forever (which would wedge the re-entrancy guard / watchdog).
                        console.warn(`⚠️ Channel closed — ${this.connState()}`);
                        this.syncReachabilityStatus();
                        reject(new Error('Tool call channel closed during subscribe'));
                    }
                });
        });
    }

    /**
     * Handle a 'new_call' broadcast doorbell. The doorbell carries only ids —
     * the authoritative row is fetched by primary key and fed through the SAME
     * handler as a postgres_changes payload, so device.ts is transport-agnostic.
     * During the transition both transports deliver every call; the claim in
     * markCallExecuting() guarantees single execution.
     */
    private async onDoorbell(payload: any): Promise<void> {
        const callId = payload?.call_id;
        if (!callId) return;
        if (payload?.device_id && payload.device_id !== this.deviceId) {
            console.debug('[DEBUG] Ignoring doorbell for different device');
            return;
        }

        // NOTE: deliberately NOT a telemetry event — this fires on every remote
        // tool call (~126k/day in prod) and would be permanent per-call volume.
        // Transport usage is already segmentable server-side: dispatch stamps
        // metadata.transport, which rides mcp_command_executed. Only the
        // doorbell FAILURE paths below are worth capturing.
        console.debug('[DEBUG] Doorbell received for call:', callId);

        if (!this.client) return;

        // Retry the row fetch on transient failures (observed live: a REST
        // blip while the websocket stayed healthy). During the transition the
        // legacy postgres_changes delivery covers a lost doorbell, but after
        // the flip this fetch is the only way the device learns about the
        // call — a network hiccup must not cost a 5-minute timeout.
        let row: any = null;
        let lastError: any = null;
        for (const delayMs of [0, 500, 1500]) {
            if (delayMs > 0) await this.sleep(delayMs);
            const { data, error } = await this.client
                .from('mcp_remote_calls')
                .select('*')
                .eq('id', callId)
                .maybeSingle();
            if (!error) {
                row = data;
                lastError = null;
                break;
            }
            lastError = error;
            console.debug(`[DEBUG] Doorbell row fetch attempt failed for ${callId}: ${error.message} — retrying`);
        }

        if (lastError) {
            console.error(`[DEBUG] Doorbell row fetch failed for ${callId} after retries:`, lastError.message);
            await captureRemote('remote_channel_doorbell_fetch_error', { error: lastError });
            return;
        }
        if (!row) {
            // Row already claimed+deleted, or cleanup raced delivery — nothing to do.
            // Not retried on purpose: pre-flip the row was inserted before the
            // doorbell was sent, so a missing row means it was already claimed
            // and deleted. Post-009 this is the ONLY delivery path — see the
            // 009 preconditions if this event ever becomes non-zero.
            await captureRemote('remote_channel_doorbell_row_missing', { call_id: callId });
            return;
        }
        // OPTIMIZATION, not a correctness guard — do not rely on it. Saves a
        // hop when the legacy path already claimed this call. The actual
        // exactly-once guarantees live in device.ts: the in-process seenCallIds
        // check (same-process double delivery) and the conditional DB claim
        // (cross-process/restart).
        if (row.status !== 'pending') {
            console.debug('[DEBUG] Doorbell call already claimed via legacy path:', callId);
            return;
        }

        // Same payload shape as postgres_changes ({ new: row }).
        this.onToolCall?.({ new: row });
    }

    /**
     * Notify the server that a call's result row is written. Fire-and-forget:
     * a skipped/failed send just means the server's 10s recovery poll delivers
     * the result instead — identical to today's Realtime-hiccup behavior.
     * MUST be called only after updateCallResult() has resolved, so the
     * server's fetch-by-id finds a terminal row.
     */
    async notifyResult(callId: string): Promise<void> {
        if (!this.channel || this.channel.state !== 'joined') {
            console.debug('[DEBUG] Result doorbell skipped — channel not joined (recovery poll covers)');
            return;
        }
        try {
            // realtime-js send() RESOLVES with 'ok' | 'timed out' | 'error' —
            // it does not reject, so check the status or failures are invisible.
            const result = await this.channel.send({ type: 'broadcast', event: 'result', payload: { call_id: callId } });
            if (result === 'ok') {
                console.debug('[DEBUG] Result doorbell sent:', callId);
            } else {
                console.debug(`[DEBUG] Result doorbell not acknowledged (${result}) — recovery poll covers:`, callId);
                captureRemote('remote_channel_result_doorbell_send_failed', { result }).catch(() => { });
            }
        } catch (error: any) {
            console.debug('[DEBUG] Result doorbell send failed (recovery poll covers):', error?.message);
            captureRemote('remote_channel_result_doorbell_send_failed', { error: error?.message }).catch(() => { });
        }
    }

    /**
     * Compact connection state for logs — e.g. "socket=open(1) ch=errored attempt=3".
     * readyState 1=OPEN (a 1 while joins keep failing = a half-open socket being reused),
     * 3=CLOSED, '-'=no socket. Reads realtime-js internals defensively; never throws.
     */
    private connState(): string {
        let socket = '?';
        try {
            const rt: any = (this.client as any)?.realtime;
            socket = `${rt?.connectionState?.() ?? '?'}(${rt?.conn?.readyState ?? '-'})`;
        } catch { /* best effort */ }
        return `socket=${socket} ch=${this.channel?.state ?? '-'} attempt=${this.reconnectAttempt}`;
    }

    /**
     * Check if channel is connected, recreate if not.
     */
    private checkConnectionHealth(): void {
        if (!this.channel || !this.client || !this.user?.id || !this.onToolCall) {
            return;
        }

        const state = this.channel.state;

        // Debug: Log current channel state (only if changed)
        if (!this.lastChannelState || this.lastChannelState !== state) {
            console.debug(`[DEBUG] channel state: ${state} — ${this.connState()}`);
            this.lastChannelState = state;
        }

        // 'joined' = healthy. Clear the joining-overstay timer.
        if (state === 'joined') {
            this.joiningSince = null;
            // Self-heal a failed presence publish: the channel is up, so nothing
            // else will ever retry (SUBSCRIBED won't fire again), and without
            // presence the server reports this healthy device as offline.
            if (!this.presenceTracked && this.deviceId && !this.isTrackingPresence) {
                console.debug('[DEBUG] Channel joined but presence not tracked — retrying track()');
                this.trackPresenceWithRetry(0, 1).catch(() => { /* logged inside */ });
            }
            return;
        }

        // 'joining' = transitional — normally let realtime-js's own rejoin backoff converge
        // instead of tearing the channel down mid-join (recreating on every non-joined state
        // amputates that backoff). BUT bound it: on a half-open socket realtime-js can park
        // the channel in 'joining' indefinitely without ever reconnecting the socket, so the
        // recreate below would never fire and the device wedges offline silently. If 'joining'
        // overstays JOINING_WEDGE_TIMEOUT_MS unbroken, force a recreate — the only path that
        // disconnect()s the dead socket. (connState() in the log shows the half-open socket.)
        if (state === 'joining') {
            const now = Date.now();
            if (this.joiningSince === null) this.joiningSince = now;
            const stuckMs = now - this.joiningSince;
            if (stuckMs < JOINING_WEDGE_TIMEOUT_MS) return;
            console.debug(`[DEBUG] ⚠️ Channel stuck 'joining' ${Math.round(stuckMs / 1000)}s - forcing recreate — ${this.connState()}`);
            captureRemote('remote_channel_joining_wedge', { stuckMs, attempt: this.reconnectAttempt });
            this.joiningSince = null;
            this.recreateChannel();
            return;
        }

        // Unhealthy: closed, errored, leaving — recreate
        this.joiningSince = null;
        captureRemote('remote_channel_state_health', { state, attempt: this.reconnectAttempt });
        console.debug(`[DEBUG] ⚠️ Channel in unhealthy state '${state}' - recreating... — ${this.connState()}`);
        this.recreateChannel();
    }

    /**
     * Run an async op but reject if it doesn't settle within `ms`, so a hung await
     * can't leave isRecreatingChannel stuck true and disable the watchdog. Mirrors
     * closeWithTimeout() in desktop-commander-integration.ts.
     */
    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    private async withTimeout<T>(op: () => Promise<T>, ms: number, name: string): Promise<T> {
        let timer: NodeJS.Timeout | undefined;
        try {
            return await Promise.race([
                op(),
                new Promise<T>((_, reject) => {
                    timer = setTimeout(() => reject(new Error(`${name} timed out after ${ms}ms`)), ms);
                }),
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    /**
     * Recreate the channel by destroying old one and creating fresh instance.
     */
    private async recreateChannel(): Promise<void> {
        if (!this.client || !this.user?.id || !this.onToolCall) {
            console.warn('Cannot recreate channel - missing parameters');
            console.debug('[DEBUG] recreateChannel() aborted - missing prerequisites');
            return;
        }

        // FIX: re-entrancy guard so a 10s health tick can't stack a second recreate
        // on top of an in-flight one.
        if (this.isRecreatingChannel) {
            console.debug('[DEBUG] recreateChannel() skipped - already in progress');
            return;
        }
        this.isRecreatingChannel = true;
        this.reconnectAttempt++;

        // Create fresh channel
        console.log(`🔄 Recreating channel... (attempt ${this.reconnectAttempt}) — ${this.connState()}`);

        try {
            // Jittered exponential backoff so a fleet-wide event (server deploy,
            // Supabase blip) doesn't stampede every device into reconnecting at
            // the same instant. attempt 1 ≈ 1-3s, capped at ~15-45s. The
            // re-entrancy guard above keeps the 10s watchdog from stacking
            // recreates while we sleep.
            const backoffMs = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempt, 5)) * (0.5 + Math.random());
            console.debug(`[DEBUG] Reconnect backoff: ${Math.round(backoffMs)}ms`);
            await this.sleep(backoffMs);

            // realtime-js runs its own rejoin timer, and the backoff above gives
            // it a window to win: the old channel can come back 'joined' while we
            // slept. Destroying a healthy channel would cause a pointless outage
            // cycle — bail out instead (observed live on staging, 2026-07-23).
            if (this.channel?.state === 'joined') {
                console.log(`✅ Channel self-healed during backoff — skipping recreate — ${this.connState()}`);
                return; // finally-block below clears the re-entrancy guard
            }

            // Cap the whole recreate: a never-settling await (e.g. a subscribe that only
            // ever emits CLOSED) must not pin isRecreatingChannel=true and silently disable
            // the 10s watchdog. On timeout we reject -> catch -> finally clears the guard.
            await this.withTimeout(async () => {
                // Destroy old channel — AWAIT it so the channel registry empties before we
                // rebuild. (The un-awaited version raced the synchronous new-channel push, so
                // realtime-js never tore the socket down and a half-open one got reused.)
                if (this.channel) {
                    console.debug('[DEBUG] Destroying old channel');
                    await this.client!.removeChannel(this.channel);
                    this.channel = null;
                }
                // Rebuild the legacy channel too: it shares the socket, so a
                // socket-level wedge takes it down with the private channel.
                await this.removeLegacyChannel();

                // FIX (core): force a brand-new WebSocket. After idle / wifi-loss the socket can
                // be HALF-OPEN (readyState OPEN but dead); reusing it made every join TIME_OUT
                // forever. disconnect() drops it so the next subscribe() dials a fresh one.
                try { await (this.client as any).realtime?.disconnect?.(); } catch { /* best effort */ }

                console.debug('[DEBUG] Calling createChannel() for recreation');
                // Rebuild the legacy safety net FIRST and unconditionally: if
                // createChannel() throws or exceeds RECREATE_TIMEOUT_MS, anything
                // after it is skipped, which used to leave the fallback dead for
                // the entire duration of a private-channel outage — every
                // subsequent health tick repeating the same teardown.
                this.createLegacyChannel();
                await this.createChannel();
            }, RECREATE_TIMEOUT_MS, 'recreateChannel');
        } catch (err: any) {
            captureRemote('remote_channel_recreate_error', { errMsg: err?.message, attempt: this.reconnectAttempt });
            console.debug(`[DEBUG] Channel recreation failed: ${err?.message} — ${this.connState()}`);
            // Sustained private-channel failure: stop promising a transport we
            // cannot deliver. Until this withdrawal the flag could only ever be
            // cleared from trackPresenceInner, which is unreachable unless the
            // channel is already 'joined' — so a device that could never join
            // (008 dropped, RLS/JWT failure after a long sleep) kept advertising
            // itself, and the server's presence overlay then reported it OFFLINE
            // authoritatively, overriding a perfectly good `status` and blacking
            // it out until the process restarted.
            if (this.reconnectAttempt >= TRANSPORT_WITHDRAW_AFTER_ATTEMPTS) {
                // BOUNDED, and in its own try: this runs in the catch block,
                // which RECREATE_TIMEOUT_MS does NOT cover (it wraps only the
                // inner withTimeout above). An unbounded await here would pin
                // isRecreatingChannel=true on a hanging PATCH and silently
                // disable the 10s connection watchdog — precisely the failure
                // mode withTimeout() was introduced for.
                try {
                    await this.withTimeout(
                        () => this.setTransportCapable(false),
                        CAPABILITY_WRITE_TIMEOUT_MS,
                        'withdrawTransportCapability'
                    );
                } catch (withdrawErr: any) {
                    // Next failed recreate retries; transportCapableWritten is
                    // only advanced on a confirmed write, so nothing is lost.
                    console.debug(`[DEBUG] Capability withdrawal did not complete: ${withdrawErr?.message}`);
                }
            }
        } finally {
            this.isRecreatingChannel = false;
        }
    }

    /**
     * Claim a call for execution. Returns true only when THIS update flipped
     * the row from 'pending' to 'executing' — during the transition every call
     * is delivered twice (postgres_changes + broadcast doorbell), and this
     * claim is what guarantees it executes once. The .eq('status','pending')
     * makes the claim conditional; .select('id') makes it observable (a
     * supabase-js UPDATE returns no row data without it).
     * On a transient DB ERROR we return true (execute anyway) — matching the
     * old behavior, where a failed status write never blocked execution; the
     * duplicate-execution window that leaves is no worse than today's.
     */
    async markCallExecuting(callId: string): Promise<boolean> {
        if (!this.client) throw new Error('Client not initialized');
        const { data, error } = await this.client
            .from('mcp_remote_calls')
            .update({ status: 'executing' })
            .eq('id', callId)
            .eq('status', 'pending')
            .select('id');

        if (error) {
            console.error('[DEBUG] Failed to mark call executing:', error.message);
            await captureRemote('remote_channel_mark_call_executing_error', { error });
            return true; // preserve legacy behavior: execution proceeds despite the write error
        }

        const claimed = !!data && data.length > 0;
        if (claimed) {
            console.debug('[DEBUG] Call marked executing:', callId);
        } else {
            console.debug('[DEBUG] Call already claimed (duplicate delivery), skipping:', callId);
        }
        return claimed;
    }

    async updateCallResult(callId: string, status: string, result: any = null, errorMessage: string | null = null) {
        if (!this.client) throw new Error('Client not initialized');
        const updateData: any = {
            status: status,
            completed_at: new Date().toISOString()
        };

        // Strip NUL (U+0000) before it reaches the jsonb `result` column.
        // jsonb cannot store  and rejects the whole write (Postgres 22P05),
        // which otherwise leaves the call stuck 'executing' → the user waits out
        // a 5-minute timeout for a tool that actually ran. Common with binary
        // file reads / process output. error_message is text, so it's exempt.
        if (result !== null) updateData.result = stripNullBytes(result);
        // Postgres `text` rejects NUL too (not just jsonb) — a NUL-bearing error
        // message would fail this terminal write, and because result === null the
        // fallback below wouldn't fire, stranding the call until the 5-min timeout.
        if (errorMessage !== null) updateData.error_message = stripNullBytes(errorMessage);

        // Log a summary, not the payload: results reach 13 MB and util.inspect
        // on the hot path costs more than everything else in this function.
        console.debug(
            `[DEBUG] Updating call result: ${callId} status=${status}` +
            (result !== null ? ` resultBytes=~${JSON.stringify(updateData.result)?.length ?? 0}` : '')
        );
        const { error } = await this.client
            .from('mcp_remote_calls')
            .update(updateData)
            .eq('id', callId);

        if (error) {
            console.error('[DEBUG] Failed to update call result:', error.message);
            await captureRemote('remote_channel_update_call_result_error', { error });

            // Fail-fast fallback: if the RESULT write failed (sanitize should
            // prevent the NUL case, but any unstorable payload lands here),
            // record a terminal 'failed' with a text-only message so the user
            // gets an immediate, honest error instead of a 5-minute phantom
            // timeout. Guard against infinite recursion (only for result writes).
            if (result !== null && status !== 'failed') {
                await this.updateCallResult(
                    callId,
                    'failed',
                    null,
                    `Result could not be stored (${error.message})`
                );
            }
        } else {
            // (an UPDATE without .select() returns no row data — log the id)
            console.debug('[DEBUG] Call result updated successfully:', callId);
        }
    }

    /**
     * True while this device can still be reached by SOME transport: the
     * private user channel (broadcast doorbells) or, during the transition, its
     * independent legacy postgres_changes channel.
     *
     * The heartbeat gate deliberately asks "reachable?", not "is the private
     * channel up?". Gating on the private channel alone means a device whose
     * ONLY working transport is the legacy channel never writes last_seen, so
     * the server's 45s legacy sweep marks it offline and dispatch refuses it —
     * a total blackout for a device that can actually run tools.
     *
     * Removed with the rest of the legacy path at the flip (009), after which
     * the private channel is the only transport and this collapses back to a
     * single check.
     */
    private isReachable(): boolean {
        return this.channel?.state === 'joined' || this.legacyChannel?.state === 'joined';
    }

    /**
     * Reconcile the durable `status` column with ACTUAL reachability.
     *
     * `status` is transport-agnostic — it is the column the server's
     * resolveTargetDevice() filters on — so it must never be driven by the
     * health of ONE transport. Writing 'offline' from the private channel's
     * error path (which is what this replaces) blacked out devices whose
     * legacy channel was joined and delivering: realtime-js re-fires
     * CHANNEL_ERROR on every failed rejoin, so during a private-channel
     * outage each retry re-wrote 'offline' while the heartbeat re-wrote
     * 'online', leaving the row oscillating and roughly half of all dispatches
     * failing with "No devices available" for a perfectly healthy machine.
     *
     * Same predicate as the heartbeat gate, so the two can never disagree.
     */
    private syncReachabilityStatus(): void {
        this.queueStatusWrite(this.isReachable() ? 'online' : 'offline');
    }

    /**
     * Serialize the CHANNEL-CALLBACK status writes — not every writer. These
     * fire from un-awaited callbacks (SUBSCRIBED, CHANNEL_ERROR, CLOSED), and
     * two concurrent PATCHes to the same row land in arbitrary order: the real
     * window is inside recreateChannel(), where removeChannel()'s CLOSED writes
     * 'offline' and the fresh join's SUBSCRIBED writes 'online' ~100-300ms later
     * — comparable to a PostgREST round trip. Unordered, the 'offline' can win
     * and leave a healthy device undispatchable until the next heartbeat tick.
     *
     * Deliberately NOT the single writer: updateHeartbeat, registerDevice and
     * setOffline's subprocess all write status directly. That is fine — the
     * heartbeat re-asserting 'online' every tier interval is the intended
     * self-correction — but do not assume this chain gives total ordering.
     */
    private queueStatusWrite(status: 'online' | 'offline'): void {
        // After teardown begins, setOffline() owns the final status write.
        if (this.shuttingDown) {
            console.debug(`[DEBUG] Status write '${status}' suppressed — teardown in progress`);
            return;
        }
        this.statusWriteChain = this.statusWriteChain
            .then(() => (this.deviceId ? this.setOnlineStatus(this.deviceId, status) : undefined))
            .catch((e: any) => {
                console.error('[DEBUG] Status write failed:', e?.message);
            });
    }

    /**
     * Heartbeat cadence for the tier this device is CURRENTLY in. Follows the
     * capability flag (what the server actually tiers its sweep on), not the
     * build — see LEGACY_HEARTBEAT_INTERVAL.
     */
    private heartbeatIntervalMs(): number {
        return this.transportCapableWritten === true
            ? CAPABLE_HEARTBEAT_INTERVAL
            : LEGACY_HEARTBEAT_INTERVAL;
    }

    async updateHeartbeat(deviceId: string) {
        if (!this.client) return;
        // This write asserts status:'online' too, so it MUST respect the
        // shutdown gate — otherwise a heartbeat firing (or in flight) as SIGINT
        // lands can be applied after setOffline()'s subprocess write and leave
        // an exited process marked online with a fresh last_seen, which for a
        // capable device the sweep then cannot age out for a full tier window.
        if (this.shuttingDown) {
            console.debug('[DEBUG] Skipping heartbeat write — shutting down');
            return;
        }
        try {
            // Skip the write entirely when no transport is up. Bumping last_seen
            // on a deaf device would keep its row perpetually young, so the
            // server's staleness sweep could never age it out and correct a
            // stale 'online' — and whenever presence is unavailable (kill
            // switch, wedged socket) that stale row is exactly what dispatch
            // falls back to. Staying silent lets the sweep do its job.
            if (!this.isReachable()) {
                console.debug('[DEBUG] Skipping heartbeat write — no transport joined; letting the row age out');
                return;
            }

            const { error } = await this.client
                .from('mcp_devices')
                .update({ last_seen: new Date().toISOString(), status: 'online' })
                .eq('id', deviceId);

            if (error) {
                console.error('[DEBUG] Heartbeat update failed:', error.message);
                await captureRemote('remote_channel_heartbeat_error', { error });
            } else {
                console.debug('[DEBUG] last_seen bookkeeping write ok:', deviceId);
            }
        } catch (error: any) {
            console.error('Heartbeat failed:', error.message);
            await captureRemote('remote_channel_heartbeat_error', { error });
        }
    }

    startHeartbeat(deviceId: string) {
        console.debug('[DEBUG] Starting heartbeat for device:', deviceId);
        this.heartbeatDeviceId = deviceId;
        this.connectionCheckInterval = setInterval(() => {
            this.checkConnectionHealth();
        }, 10000);

        // Bookkeeping last_seen write. Self-rescheduling rather than a fixed
        // setInterval so the cadence can follow the tier: a device that
        // withdraws the capability flag must fall back to the fast legacy
        // cadence immediately, not 30 minutes later.
        this.scheduleHeartbeat();
        console.debug(`[DEBUG] Heartbeat started - connectionCheck: 10s, last_seen: ${this.heartbeatIntervalMs()}ms`);
    }

    /** Arm (or re-arm) the last_seen timer at the current tier's cadence. */
    private scheduleHeartbeat(): void {
        if (this.heartbeatInterval) {
            clearTimeout(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
        if (!this.heartbeatDeviceId) return;
        this.heartbeatInterval = setTimeout(async () => {
            if (this.heartbeatDeviceId) {
                await this.updateHeartbeat(this.heartbeatDeviceId);
            }
            this.scheduleHeartbeat(); // re-read the tier every tick
        }, this.heartbeatIntervalMs());
    }

    stopHeartbeat() {
        this.heartbeatDeviceId = null;
        if (this.heartbeatInterval) {
            clearTimeout(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
        if (this.connectionCheckInterval) {
            clearInterval(this.connectionCheckInterval);
            this.connectionCheckInterval = null;
        }
    }

    async setOnlineStatus(deviceId: string, status: 'online' | 'offline') {
        if (!this.client) return;

        // Only log if status changed
        if (this.lastDeviceStatus !== status) {
            console.log(`🔌 Device marked as ${status}`);
            this.lastDeviceStatus = status;
        }

        const { error } = await this.client
            .from('mcp_devices')
            .update({ status: status, last_seen: new Date().toISOString() })
            .eq('id', deviceId);

        if (error) {
            console.error(`[DEBUG] Failed to set status ${status}:`, error.message);
            if (status == "online") {
                console.error('Failed to update device status:', error.message);
            }
            await captureRemote('remote_channel_status_update_error', { error, status });
            return;
        } else {
            console.debug(`[DEBUG] Device status set to ${status}`);
        }

        // console.log(status === 'online' ? `🔌 Device marked as ${status}` : `❌ Device marked as ${status}`);
    }

    async setOffline(deviceId: string | undefined) {
        if (!deviceId || !this.client) {
            console.debug('[DEBUG] setOffline() skipped - no deviceId or client');
            return;
        }

        console.debug('[DEBUG] setOffline() initiating blocking update for device:', deviceId);

        try {
            // Get a session for the subprocess — BOUNDED, with a fallback.
            //
            // auth.getSession() is not a cheap storage read: it takes a lock with
            // a 10s acquire timeout, and it refreshes when the token is merely
            // WITHIN ~90s of expiry, which POSTs /token with its own retry
            // budget (~30s on retryable network errors). On a just-woken machine
            // — token near expiry, wifi not re-associated — that is exactly the
            // shape that blows device.ts's 5s force-exit, and then spawnSync
            // never runs and the durable offline write never lands. That row
            // then reads 'online' for the whole capable sweep tier, with every
            // dispatch to it costing the caller a 5-minute timeout.
            //
            // The subprocess calls setSession() itself, so a slightly stale
            // access_token is fine as long as the refresh_token is good.
            const live = await Promise.race([
                this.client.auth.getSession().then((r) => r.data?.session ?? null),
                this.sleep(OFFLINE_SESSION_TIMEOUT_MS).then(() => null),
            ]).catch(() => null);
            const session = live ?? this.lastKnownSession;

            if (!session?.access_token) {
                console.error('❌ No valid session for offline update');
                console.debug('[DEBUG] Session data missing or invalid');
                return;
            }
            if (!live) {
                console.debug('[DEBUG] getSession() slow/failed — using last known session tokens');
            }

            // Get Supabase config from client
            const supabaseUrl = (this.client as any).supabaseUrl;
            const supabaseKey = (this.client as any).supabaseKey;

            if (!supabaseUrl || !supabaseKey) {
                console.error('❌ Missing Supabase configuration');
                console.debug('[DEBUG] supabaseUrl or supabaseKey is missing');
                return;
            }

            // Use spawnSync to run the blocking update script
            const { spawnSync } = await import('child_process');
            const { fileURLToPath } = await import('url');
            const path = await import('path');

            // Get the script path relative to this file
            const __filename = fileURLToPath(import.meta.url);
            const __dirname = path.dirname(__filename);
            const scriptPath = path.join(__dirname, 'scripts', 'blocking-offline-update.js');

            console.debug('[DEBUG] Spawning blocking update script:', scriptPath);
            console.debug('[DEBUG] Using node executable:', process.execPath);

            const result = spawnSync('node', [
                scriptPath,
                deviceId,
                supabaseUrl,
                supabaseKey,
                session.access_token,
                session.refresh_token || ''
            ], {
                timeout: 3000,
                stdio: 'pipe', // Capture output to prevent blocking
                encoding: 'utf-8'
            });

            console.debug('[DEBUG] spawnSync completed, exit code:', result.status, 'signal:', result.signal);

            // Log subprocess output (with encoding:'utf-8', these are already strings)
            if (result.stdout && result.stdout.trim()) {
                console.log(result.stdout.trim());
            }
            if (result.stderr && result.stderr.trim()) {
                console.error(result.stderr.trim());
            }

            // Handle exit codes
            if (result.error) {
                console.error('❌ Failed to spawn update process:', result.error.message);
                console.debug('[DEBUG] spawn error:', result.error);
            } else if (result.status === 0) {
                console.log('✓ Device marked as offline (blocking)');
            } else if (result.status === 2) {
                console.warn('⚠️ Device offline update timed out');
            } else if (result.signal) {
                console.error(`❌ Update process killed by signal: ${result.signal}`);
            } else {
                console.error(`❌ Update process failed with exit code: ${result.status}`);
            }

        } catch (error: any) {
            console.error('❌ Error in blocking offline update:', error.message);
            console.debug('[DEBUG] setOffline() error stack:', error.stack);
            await captureRemote('remote_channel_offline_update_error', { error });
        }
    }

    async unsubscribe() {
        // Teardown has begun: from here on, setOffline()'s durable write is the
        // authoritative final word on `status`, so stop every other writer
        // (channel callbacks AND the heartbeat) from racing it. Otherwise a
        // late 'online' is applied after the subprocess has written 'offline',
        // leaving an exited process marked online until the sweep ages it out —
        // and every dispatch in between costs the caller a 5-minute timeout.
        //
        // The window that actually needs this is NOT the CLOSED fired by the
        // unsubscribe below: realtime-js sets state='leaving' on the first line
        // of unsubscribe() and removeChannel() calls it synchronously, so by the
        // time that CLOSED lands isReachable() already reads false and the write
        // would have been 'offline' anyway. The real races are:
        //   1. a heartbeat tick (every 15s in the legacy tier) firing or already
        //      in flight as the signal arrives — see updateHeartbeat, and
        //   2. SIGINT arriving while recreateChannel() sits in its jittered
        //      backoff (up to ~45s): this.channel is already null so unsubscribe
        //      skips its block, setOffline writes 'offline', then the backoff
        //      expires during desktop.shutdown() and the fresh join's SUBSCRIBED
        //      queues 'online' after the durable write.
        this.shuttingDown = true;
        // BUDGET: device.ts force-exits 5s after the signal, and the durable
        // offline write (setOffline's spawnSync, 3s cap + a bounded session
        // fetch, 0.5s) is the one thing this whole path exists to produce. So
        // everything before it must be tightly bounded:
        //   250ms drain + 500ms untrack + 500ms(×2, see below) + 500ms session
        //   + 3000ms spawnSync  ≈ 4.75s worst case
        // Only the untrack bound can actually bind: removeChannel/unsubscribe
        // both set state='leaving' first, which makes realtime-js's _canPush()
        // false so the leave push resolves 'ok' inline rather than waiting out
        // its 10s timeout. The other two bounds are cheap insurance, not load-
        // bearing — do not "reclaim" the budget by removing the untrack one.
        const LEAVE_BOUND_MS = 500;
        // Drain the QUEUED channel-callback writes. This cannot drain a
        // heartbeat PATCH — updateHeartbeat writes directly, not through the
        // chain — but the gate above stops any NEW heartbeat, and one already in
        // flight necessarily started before this point.
        await Promise.race([this.statusWriteChain, this.sleep(250)]);
        // Bounded like the untrack below: removeChannel() sends a leave push that
        // only settles via realtime-js's 10s timeout on a half-open socket, which
        // would blow device.ts's 5s force-exit and skip the durable offline write.
        await Promise.race([this.removeLegacyChannel(), this.sleep(LEAVE_BOUND_MS)]);
        if (this.channel) {
            // Leave presence explicitly on the graceful path (socket close
            // covers the abrupt one).
            try {
                // Bound the untrack: a HALF-OPEN socket still reports the channel
                // as 'joined', so a state check alone is not enough — the presence
                // push just buffers and settles via realtime-js's 10s timeout,
                // which blows past device.ts's 5s force-exit and would skip both
                // unsubscribe() and the durable offline write. A dropped socket
                // clears server-side presence anyway.
                await Promise.race([
                    this.channel.untrack(),
                    this.sleep(LEAVE_BOUND_MS),
                ]);
                console.debug('[DEBUG] Presence untrack attempted (bounded)');
            } catch { /* best effort */ }
            // Bounded as insurance only. unsubscribe() sets state='leaving' on
            // its first line, so _canPush() is false and the leave push resolves
            // 'ok' inline — it cannot actually wait out the 10s push timeout the
            // way the untrack above can. Kept because it costs nothing and the
            // guarantee lives in library internals, not in our contract.
            await Promise.race([this.channel.unsubscribe(), this.sleep(LEAVE_BOUND_MS)]);
            this.channel = null;
            console.log('✓ Unsubscribed from tool call channel');
        }
    }
}
