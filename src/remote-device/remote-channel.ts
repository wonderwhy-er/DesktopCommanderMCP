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

// Bookkeeping cadence for the durable last_seen column. Liveness is carried by
// Presence on the user channel (websocket-level, flips in seconds) — this slow
// write only feeds the "last seen X ago" label for offline devices. The server
// sweeps broadcast-capable devices offline after 65 min (2 missed writes + slack).
const HEARTBEAT_INTERVAL = 30 * 60 * 1000;
// Cap the channel-rebuild portion of a recreate so a hung await can't pin the
// re-entrancy guard true (which would silently disable the connection watchdog).
// NOTE: the jittered backoff sleep runs BEFORE this cap and inside the guard, so
// the total window in which checkConnectionHealth is a no-op is
// backoff (<=45s) + RECREATE_TIMEOUT_MS — bounded at ~75s, not 30s.
const RECREATE_TIMEOUT_MS = 30000;
// Max time the channel may sit CONTINUOUSLY in 'joining' before we force a recreate.
// 'joining' is normally healthy (we let realtime-js's rejoin backoff converge), but on a
// HALF-OPEN socket (readyState OPEN yet dead) realtime-js parks the channel in 'joining'
// forever and never reconnects the socket — the device then wedges offline silently with
// no recreate firing. realtime-js's join push times out in ~10s, so a genuine join
// resolves/errors well within this window; 3 health ticks of unbroken 'joining' means the
// state machine has stalled and only a fresh socket (via recreate) recovers it.
const JOINING_WEDGE_TIMEOUT_MS = 30000;

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
        console.debug('[DEBUG] Realtime socket authorized with current session JWT');
        if (!this.authListenerRegistered) {
            this.authListenerRegistered = true;
            this.client.auth.onAuthStateChange((event, newSession) => {
                if (event === 'TOKEN_REFRESHED' && newSession?.access_token && this.client) {
                    console.debug('[DEBUG] Token refreshed — re-authorizing realtime socket');
                    this.client.realtime.setAuth(newSession.access_token);
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
            await this.updateDevice(existingDevice.id, {
                status: 'online',
                last_seen: new Date().toISOString(),
                // transport_broadcast_v1 = this device joins the private user
                // channel (Broadcast doorbells + Presence). The server keys its
                // transport choice and offline-sweep tier on this flag.
                // app_version rides along so adoption ("are old versions gone
                // yet?") is answerable from SQL and PostHog alike.
                capabilities: { transport_broadcast_v1: true, app_version: VERSION },
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
                captureRemote('remote_channel_presence_tracked', { attempt: recovered }).catch(() => { });
                return;
            }

            console.error(`❌ Presence track not acknowledged (${status}) — attempt ${attempt}/${attempts}`);
            if (attempt < attempts) await this.sleep(500 * attempt);
        }

        this.presenceTracked = false;
        console.error('❌ Presence track failed after retries — device may show offline until the next health tick');
        captureRemote('remote_channel_presence_track_error', { attempts }).catch(() => { });
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
            if (!this.client || !this.user?.id || !this.onToolCall) {
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
                    presence: { key: this.deviceId ?? undefined, enabled: true }
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
                        // Update device status on successful connection
                        if (this.deviceId) {
                            this.setOnlineStatus(this.deviceId, 'online').catch(e => {
                                console.error('Failed to set online status:', e.message);
                            });
                        }
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
                        this.setOnlineStatus(this.deviceId!, 'offline');
                        // Single event: this fires on ordinary network faults too, so a
                        // separate "private join failed" alarm would be a 1:1 duplicate
                        // with no added specificity. Filter on the error text
                        // ("Unauthorized"/policy) to isolate an 008 misconfiguration.
                        captureRemote('remote_channel_subscription_error', { error: err?.message || 'Channel error' }).catch(() => { });
                        reject(err || new Error('Failed to initialize tool call channel subscription'));
                    } else if (status === 'TIMED_OUT') {
                        console.error(`⏱️ Channel subscription timed out, Reconnecting... — ${this.connState()}`);
                        this.setOnlineStatus(this.deviceId!, 'offline');
                        captureRemote('remote_channel_subscription_timeout', { attempt: this.reconnectAttempt }).catch(() => { });
                        reject(new Error('Tool call channel subscription timed out'));
                    } else if (status === 'CLOSED') {
                        // Settle the promise so an in-flight recreateChannel() can't await
                        // forever (which would wedge the re-entrancy guard / watchdog), and
                        // mark the device offline like the other degraded states.
                        console.warn(`⚠️ Channel closed — ${this.connState()}`);
                        this.setOnlineStatus(this.deviceId!, 'offline');
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
            if (!this.presenceTracked && this.deviceId) {
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
                await this.createChannel();
                this.createLegacyChannel();
            }, RECREATE_TIMEOUT_MS, 'recreateChannel');
        } catch (err: any) {
            captureRemote('remote_channel_recreate_error', { errMsg: err?.message, attempt: this.reconnectAttempt });
            console.debug(`[DEBUG] Channel recreation failed: ${err?.message} — ${this.connState()}`);
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

        console.debug('[DEBUG] Updating call result:', updateData);
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

    async updateHeartbeat(deviceId: string) {
        if (!this.client) return;
        try {
            // Skip the write entirely when the channel is not joined. Bumping
            // last_seen on a deaf device would keep its row perpetually young, so
            // the server's staleness sweep could never age it out and correct a
            // stale 'online' — and whenever presence is unavailable (kill switch,
            // wedged socket) that stale row is exactly what dispatch falls back to.
            // Staying silent lets the sweep do its job.
            if (this.channel?.state !== 'joined') {
                console.debug('[DEBUG] Skipping heartbeat write — channel not joined; letting the row age out');
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
                // At 30-min cadence this is ~2 lines/hour — worth the visibility.
                console.debug('[DEBUG] last_seen bookkeeping write ok:', deviceId);
            }
        } catch (error: any) {
            console.error('Heartbeat failed:', error.message);
            await captureRemote('remote_channel_heartbeat_error', { error });
        }
    }

    startHeartbeat(deviceId: string) {
        console.debug('[DEBUG] Starting heartbeat for device:', deviceId);
        this.connectionCheckInterval = setInterval(() => {
            this.checkConnectionHealth();
        }, 10000);

        // Bookkeeping last_seen write (liveness itself rides Presence)
        this.heartbeatInterval = setInterval(async () => {
            await this.updateHeartbeat(deviceId);
        }, HEARTBEAT_INTERVAL);
        console.debug('[DEBUG] Heartbeat intervals set - connectionCheck: 10s, last_seen bookkeeping: 30min');
    }

    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
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
            // Get current session for the subprocess
            const { data: sessionData } = await this.client.auth.getSession();

            if (!sessionData?.session?.access_token) {
                console.error('❌ No valid session for offline update');
                console.debug('[DEBUG] Session data missing or invalid');
                return;
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
                sessionData.session.access_token,
                sessionData.session.refresh_token || ''
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
        await this.removeLegacyChannel();
        if (this.channel) {
            // Leave presence explicitly on the graceful path (socket close
            // covers the abrupt one).
            try {
                // Bound the untrack: a HALF-OPEN socket still reports the channel
                // as 'joined', so a state check alone is not enough — the presence
                // push just buffers and settles via realtime-js's 10s timeout,
                // which blows past device.ts's 5s force-exit and would skip both
                // unsubscribe() and the durable offline write. Race it against a
                // 1s cap; a dropped socket clears server-side presence anyway.
                await Promise.race([
                    this.channel.untrack(),
                    this.sleep(1000),
                ]);
                console.debug('[DEBUG] Presence untrack attempted (bounded at 1s)');
            } catch { /* best effort */ }
            await this.channel.unsubscribe();
            this.channel = null;
            console.log('✓ Unsubscribed from tool call channel');
        }
    }
}
