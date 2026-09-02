import { createClient, SupabaseClient, Session, UserResponse, User, RealtimeChannel } from '@supabase/supabase-js';
import { captureRemote } from '../utils/capture.js';
import { VERSION } from '../version.js';

const NUL_CHAR = String.fromCharCode(0);
const NUL_RE = new RegExp(NUL_CHAR, 'g');

/**
 * Strip NUL characters (U+0000) from strings and object keys — Postgres rejects
 * them in jsonb and text (22P05). Walks the structure rather than
 * round-tripping JSON, which would also match escape text in legitimate content.
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

// last_seen cadences. The server tiers its sweep on the transport_broadcast_v1
// flag, so each must fit its tier's threshold in the server's constants.ts:
// capable -> 15 min, unflagged -> 45s.
const CAPABLE_HEARTBEAT_INTERVAL = 5 * 60 * 1000;
const LEGACY_HEARTBEAT_INTERVAL = 15 * 1000;
// Cap on a recreate's rebuild step so a hung await can't disable the watchdog.
// Must exceed createChannel()'s worst case (~31.5s of presence retries).
const RECREATE_TIMEOUT_MS = 45000;
// Max continuous time in 'joining' before forcing a recreate — a half-open
// socket parks the channel there forever, and a genuine join settles in ~10s.
const JOINING_WEDGE_TIMEOUT_MS = 30000;
// Failed recreates before withdrawing transport_broadcast_v1 — keeping it while
// unable to join makes the device undispatchable. Not lower than 3: ordinary
// half-open recovery legitimately costs 2.
const TRANSPORT_WITHDRAW_AFTER_ATTEMPTS = 3;
// Cap on the withdrawal write; it runs in a catch block RECREATE_TIMEOUT_MS
// does not cover.
const CAPABILITY_WRITE_TIMEOUT_MS = 5000;
// Cap on the shutdown session fetch, which races device.ts's 5s force-exit.
const OFFLINE_SESSION_TIMEOUT_MS = 500;
// realtime-js parks in 'disconnecting' for ~100ms after a disconnect and
// connect() early-returns for that whole window (see waitForSocketSettled).
// Bound generously — this only ever delays a recreate, which RECREATE_TIMEOUT_MS
// already covers.
const SOCKET_SETTLE_MAX_MS = 300;
const SOCKET_SETTLE_POLL_MS = 20;

export class RemoteChannel {
    private client: SupabaseClient | null = null;
    private channel: RealtimeChannel | null = null;
    /** Legacy listener, on its own public channel so a private-channel auth
     * failure can't take both transports down. Removed at the flip (009). */
    private legacyChannel: RealtimeChannel | null = null;
    private heartbeatInterval: NodeJS.Timeout | null = null;
    private connectionCheckInterval: NodeJS.Timeout | null = null;
    /** Device the heartbeat timer maintains; null = stopped, so re-arm is inert. */
    private heartbeatDeviceId: string | null = null;
    // Single-slot queue keeping concurrent `status` PATCHes in order.
    private statusWriteChain: Promise<void> = Promise.resolve();
    /** Tokens from the last setSession / TOKEN_REFRESHED, for setOffline(). */
    private lastKnownSession: { access_token: string; refresh_token: string | null } | null = null;
    /** Set by unsubscribe(): suppresses status/heartbeat writes so they can't
     * land after setOffline()'s durable write. */
    private shuttingDown = false;
    /** Auth session gone for good: stops rejoins and caps the notice at one line. */
    private sessionLost = false;
    private handlingSignedOut = false;


    // Store subscription parameters for channel recreation
    private deviceId: string | null = null;
    private deviceName: string | null = null;
    private onToolCall: ((payload: any) => void) | null = null;
    // Guard so setSession being called twice can't stack auth listeners.
    private authListenerRegistered = false;
    /** False when presence publishing failed on an otherwise healthy channel;
     * the health check retries, since SUBSCRIBED won't fire again. */
    private presenceTracked = false;
    /** Last capability value written (null = never), to avoid redundant writes. */
    private transportCapableWritten: boolean | null = null;
    /** Re-entrancy guard: on a wedged socket each track() buffers for the full
     * 10s push timeout, so 10s health ticks would stack pushes. */
    private isTrackingPresence = false;

    // Track last device status to prevent duplicate log messages
    private lastDeviceStatus: 'online' | 'offline' = 'offline';

    // Track last channel state for debug logging
    private lastChannelState: string | null = null;

    private reconnectAttempt = 0;        // recreates since the last success
    private isRecreatingChannel = false; // re-entrancy guard
    private joiningSince: number | null = null; // start of an unbroken 'joining' run

    private _user: User | null = null;
    get user(): User | null { return this._user; }


    initialize(url: string, key: string): void {
        this.client = createClient(url, key, {
            realtime: {
                // supabase-js's resolver ends in `?? supabaseKey`, so after SIGNED_OUT
                // the socket silently re-pins to the anon key and every private-channel
                // join is refused. Overriding under `realtime` (not the top-level
                // `accessToken`, which turns client.auth into a throwing Proxy).
                accessToken: async (): Promise<string | null> => {
                    try {
                        const { data } = await this.client!.auth.getSession();
                        if (data.session?.access_token) return data.session.access_token;
                    } catch {
                        /* fall through to the cached token */
                    }
                    return this.lastKnownSession?.access_token ?? null;
                },
            },
        });
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

        // Push the CURRENT token, not the one we were handed: setSession()
        // refreshes internally, and the stale parameter would overwrite it.
        const { data: { session: currentSession } } = await this.client.auth.getSession();
        const realtimeToken = currentSession?.access_token ?? session.access_token;
        this.client.realtime.setAuth(realtimeToken);
        // Cached for setOffline(), which can't afford to wait on getSession().
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
                } else if (event === 'SIGNED_OUT') {
                    void this.handleSignedOut();
                }
            });
        }

        return { error };
    }

    /**
     * Session gone: one restore attempt, then go offline and stop retrying.
     *
     * The attempt matters because auth-js only treats network errors and 502/503/504
     * as retryable — a 429 or 500 kills the session while the refresh token is fine.
     * We don't re-authenticate: DeviceAuthenticator opens a browser and waits.
     */
    private async handleSignedOut(): Promise<void> {
        if (this.handlingSignedOut || this.sessionLost || this.shuttingDown) return;
        this.handlingSignedOut = true;
        try {
            const cached = this.lastKnownSession;
            if (cached?.refresh_token && this.client) {
                console.debug('[DEBUG] SIGNED_OUT — attempting one session restore');
                let restoreError: any = null;
                try {
                    const { error } = await this.client.auth.setSession({
                        access_token: cached.access_token,
                        refresh_token: cached.refresh_token,
                    });
                    restoreError = error ?? null;
                    if (!restoreError) {
                        // auth-js refreshes ahead of expiry, so on SIGNED_OUT the cached
                        // JWT is usually still unexpired — setSession() then never touches
                        // the refresh endpoint, and a revoked refresh token would come back
                        // "restored" only to 400 again on the next tick. Force a real
                        // refresh so restore succeeds only with a live refresh token.
                        const { data, error: refreshError } = await this.client.auth.refreshSession();
                        restoreError = refreshError ?? null;
                        if (!restoreError) {
                            const renewed = data?.session;
                            if (renewed?.access_token) {
                                this.lastKnownSession = {
                                    access_token: renewed.access_token,
                                    refresh_token: renewed.refresh_token ?? cached.refresh_token,
                                };
                            }
                            console.log('   - ✅ Remote session restored after a transient sign-out');
                            await captureRemote('remote_channel_signed_out_recovered', {});
                            return;
                        }
                    }
                } catch (thrown: any) {
                    // setSession() with an unexpired JWT validates via _getUser() and
                    // THROWS on error instead of returning { error }.
                    restoreError = thrown;
                }
                await captureRemote('remote_channel_session_restore_failed', {
                    errorName: restoreError?.name ?? null,
                    errorStatus: restoreError?.status ?? null,
                    errorMessage: restoreError?.message ?? null,
                });
                console.debug(`[DEBUG] Session restore failed: ${restoreError?.message}`);
            }

            this.sessionLost = true;
            await captureRemote('remote_channel_session_lost', {
                hadRefreshToken: !!cached?.refresh_token,
            });

            this.stopHeartbeat();

            // Tear realtime down entirely, same as recreateChannel() does: sessionLost
            // only gates OUR health loop, while realtime-js keeps its own per-channel
            // rejoin timer (~10s cap) firing expired-JWT joins on the errored channel
            // until the channel is removed — measured in the 2026-08-18 staging rig at
            // ~2.5k Unauthorized joins/device/day even with the downgrade guard active.
            try {
                if (this.channel) {
                    await this.client?.removeChannel(this.channel);
                    this.channel = null;
                }
                await this.removeLegacyChannel();
                try { await (this.client as any)?.realtime?.disconnect?.(); } catch { /* best effort */ }
            } catch (teardownError: any) {
                console.debug(`[DEBUG] Session-lost channel teardown failed: ${teardownError?.message}`);
            }

            try {
                await this.setOffline(this.deviceId ?? undefined);
            } catch { /* best effort */ }

            console.error('\n⚠️  Remote session expired and could not be renewed.');
            console.error('   This device is now offline for remote calls; local tools still work.');
            console.error('   Restart the terminal running Desktop Commander to reconnect.\n');
        } catch (error: any) {
            console.debug(`[DEBUG] handleSignedOut() failed: ${error?.message}`);
        } finally {
            this.handlingSignedOut = false;
        }
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
            // transport_broadcast_v1 is NOT set here: the server treats it as
            // binding, so it is written only once presence is proven.
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

            // Independent safety net for the doorbell transport.
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
     * Publish presence, retrying a non-'ok' result — track() resolves with a
     * status rather than rejecting, and absent presence reads as offline on the
     * server. `presenceTracked` lets the health check retry later.
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
                // Reconnect attempts preceding this join (0 on a first join).
                captureRemote('remote_channel_presence_tracked', { recoveredAfterAttempts: recovered }).catch(() => { });
                // Proven end-to-end (joined AND presence published) — only now
                // may the server treat our presence as authoritative.
                await this.setTransportCapable(true);
                return;
            }

            console.error(`❌ Presence track not acknowledged (${status}) — attempt ${attempt}/${attempts}`);
            if (attempt < attempts) await this.sleep(500 * attempt);
        }

        this.presenceTracked = false;
        console.error('❌ Presence track failed after retries — reverting to the legacy transport tier');
        captureRemote('remote_channel_presence_track_error', { attempts }).catch(() => { });
        // Withdraw: a stale flag with no presence makes the server refuse to
        // dispatch at all. The legacy tier keeps the device usable.
        await this.setTransportCapable(false);
    }

    /**
     * The complete `capabilities` JSONB value. One place only: every write
     * replaces the whole column, so a second literal would silently drop keys.
     */
    private capabilitiesPayload(broadcastCapable: boolean): Record<string, any> {
        return {
            app_version: VERSION,
            ...(broadcastCapable ? { transport_broadcast_v1: true } : {})
        };
    }

    /**
     * Advertise (or withdraw) the broadcast capability. Only true while genuinely
     * reachable that way — the server uses it to pick a transport, to read absent
     * presence as offline, and to choose the sweep tier, so every change must
     * re-arm the heartbeat.
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
            // last_seen may already be past the 45s threshold now judging us,
            // so write once immediately rather than waiting out the interval.
            if (!capable && this.heartbeatDeviceId) {
                this.updateHeartbeat(this.heartbeatDeviceId).catch(() => { /* logged inside */ });
            }
        } catch (error: any) {
            console.error('[DEBUG] Transport capability update threw:', error?.message);
        }
    }

    /**
     * Legacy postgres_changes listener on its own public channel. Best-effort:
     * failures are logged, never thrown. Removed at the flip (009).
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
                        this.dispatchToolCall(payload);
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

    /** Create and subscribe the private channel (initial join and recreation). */
    private createChannel(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.client || !this.user?.id || !this.onToolCall || !this.deviceId) {
                // deviceId is the presence KEY; a null key gets a random one and
                // the server's lookup by device id silently misses.
                console.debug('[DEBUG] createChannel() failed - missing prerequisites');
                return reject(new Error('Client not initialized or missing subscription parameters'));
            }

            // Private per-user channel: new_call doorbells + this device's
            // Presence, keyed by device id.
            const channelName = `user:${this.user.id}`;
            console.debug(`[DEBUG] Creating channel: ${channelName}`);
            this.channel = this.client.channel(channelName, {
                // ack: true — without it send() resolves 'ok' once the frame hits
                // the socket, making notifyResult's status check dead code.
                config: {
                    private: true,
                    broadcast: { ack: true },
                    // Non-null: the guard above rejects when !deviceId.
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
                        // Presence is the live signal dispatch reads, so resolve
                        // only once it lands — otherwise registerDevice() reports
                        // "Device ready" while still undispatchable.
                        this.trackPresenceWithRetry(recovered)
                            .catch(() => { /* logged inside */ })
                            .finally(() => resolve());
                    } else if (status === 'CHANNEL_ERROR') {
                        // CHANNEL_ERROR is the only status carrying a real error message.
                        console.error(`❌ Channel error: ${err?.message || 'unknown'} — ${this.connState()}`);
                        this.presenceTracked = false;
                        this.syncReachabilityStatus();
                        // Fires on ordinary network faults too — filter on the
                        // error text to isolate an 008 misconfiguration.
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

    /** Hand a call to device.ts, observing the rejection — the handler is async
     * and an unhandled rejection terminates the process. */
    private dispatchToolCall(payload: any): void {
        try {
            const maybePromise = this.onToolCall?.(payload) as unknown;
            if (maybePromise instanceof Promise) {
                maybePromise.catch((e: any) => {
                    console.error('[DEBUG] Tool call handler rejected:', e?.message);
                });
            }
        } catch (e: any) {
            console.error('[DEBUG] Tool call handler threw:', e?.message);
        }
    }

    /**
     * Handle a 'new_call' doorbell. It carries ids only; the row is fetched by
     * primary key and fed through the same handler as a postgres_changes
     * payload, so device.ts stays transport-agnostic.
     */
    private async onDoorbell(payload: any): Promise<void> {
        const callId = payload?.call_id;
        if (!callId) return;
        if (payload?.device_id && payload.device_id !== this.deviceId) {
            console.debug('[DEBUG] Ignoring doorbell for different device');
            return;
        }

        // Not a telemetry event on purpose: ~126k/day in prod. Transport usage
        // is already segmentable server-side via metadata.transport.
        console.debug('[DEBUG] Doorbell received for call:', callId);

        if (!this.client) return;

        // Retry on transient failures (a REST blip while the socket stays
        // healthy). Post-flip this fetch is the only way we learn about a call,
        // so a hiccup must not cost a 5-minute timeout.
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
            // Already claimed and deleted, or cleanup raced delivery. Not
            // retried: the row is always inserted before the doorbell is sent.
            await captureRemote('remote_channel_doorbell_row_missing', { call_id: callId });
            return;
        }
        // Optimization, not a guard — saves a hop when the legacy path already
        // claimed this. Exactly-once lives in device.ts (seenCallIds + DB claim).
        if (row.status !== 'pending') {
            console.debug('[DEBUG] Doorbell call already claimed via legacy path:', callId);
            return;
        }

        // Same payload shape as postgres_changes ({ new: row }).
        this.dispatchToolCall({ new: row });
    }

    /**
     * Tell the server a result row is written. Fire-and-forget: a failed send
     * just falls back to the server's 10s recovery poll. MUST run only after
     * updateCallResult() resolves, so the server's fetch-by-id sees a terminal row.
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
        if (this.sessionLost) return;
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

        // 'joining' is transitional — let realtime-js's rejoin backoff converge
        // rather than tearing the channel down mid-join. But bound it: a
        // half-open socket parks the channel here indefinitely, so past
        // JOINING_WEDGE_TIMEOUT_MS force a recreate, the only path that
        // disconnect()s the dead socket.
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

    /**
     * Block until realtime-js has left the 'disconnecting' state it enters on
     * disconnect(), so the next subscribe() actually dials a socket instead of
     * hitting connect()'s early return. Bounded either way — worst case we cost
     * a recreate SOCKET_SETTLE_MAX_MS.
     */
    private async waitForSocketSettled(): Promise<void> {
        const realtime = (this.client as any)?.realtime;
        // No predicate to poll (older/newer client): wait out the internal
        // fallback timer blind rather than guess at the state.
        if (typeof realtime?.isDisconnecting !== 'function') {
            await this.sleep(SOCKET_SETTLE_MAX_MS);
            return;
        }
        const deadline = Date.now() + SOCKET_SETTLE_MAX_MS;
        while (realtime.isDisconnecting() && Date.now() < deadline) {
            await this.sleep(SOCKET_SETTLE_POLL_MS);
        }
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
            // Jittered backoff so a fleet-wide event doesn't stampede every
            // device into reconnecting at once. ~1-3s rising to ~15-45s.
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
                // Await it so the channel registry empties before we rebuild —
                // otherwise realtime-js never tears the socket down and a
                // half-open one gets reused.
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

                // ...but disconnect() is not synchronous from connect()'s point
                // of view: it parks _connectionState in 'disconnecting' and
                // _teardownConnection() nulls the conn.onclose that would clear
                // it, so only an internal ~100ms fallback timer does. connect()
                // early-returns for that whole window, so rebuilding here makes
                // subscribe()'s socket.connect() a silent no-op and BOTH
                // channels sit in 'joining' until the 10s join timeout — the
                // wasted-first-recreate that left the device dark on the legacy
                // channel too. Wait for the state to settle before rebuilding.
                await this.waitForSocketSettled();

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
            // Sustained failure: stop promising a transport we can't deliver, or
            // the server's presence overlay reports this device offline
            // authoritatively and overrides `status`.
            if (this.reconnectAttempt >= TRANSPORT_WITHDRAW_AFTER_ATTEMPTS) {
                // Bounded, in its own try: this catch block is outside
                // RECREATE_TIMEOUT_MS, so a hanging PATCH would pin
                // isRecreatingChannel and disable the watchdog.
                try {
                    await this.withTimeout(
                        () => this.setTransportCapable(false),
                        CAPABILITY_WRITE_TIMEOUT_MS,
                        'withdrawTransportCapability'
                    );
                } catch (withdrawErr: any) {
                    // The next failed recreate retries; the flag only advances
                    // on a confirmed write, so nothing is lost.
                    console.debug(`[DEBUG] Capability withdrawal did not complete: ${withdrawErr?.message}`);
                }
            }
        } finally {
            this.isRecreatingChannel = false;
        }
    }

    /**
     * Claim a call. True only when THIS update flipped the row pending ->
     * executing, which is what makes dual delivery safe across processes.
     * .eq('status','pending') makes it conditional; .select('id') makes the
     * result observable. On a transient DB error it returns true (execute
     * anyway), matching prior behaviour — so device.ts's in-memory guard is what
     * actually guarantees exactly-once within a process.
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

        // Gated: the size is only knowable by serializing, and results reach
        // 13 MB — doing that eagerly for a log line would cost more than the
        // rest of this function.
        if (process.env.DEBUG_MODE === 'true') {
            console.debug(
                `[DEBUG] Updating call result: ${callId} status=${status}` +
                (result !== null ? ` resultBytes=~${JSON.stringify(updateData.result)?.length ?? 0}` : '')
            );
        }
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
     * Reachable by SOME transport — the private channel or, during the
     * transition, the independent legacy one. Gates the heartbeat and `status`:
     * asking only about the private channel starves last_seen for a device whose
     * legacy channel is fine, and the 45s sweep then blacks it out.
     * Collapses to a single check at the flip (009).
     */
    private isReachable(): boolean {
        return this.channel?.state === 'joined' || this.legacyChannel?.state === 'joined';
    }

    /**
     * Set `status` from actual reachability. `status` is transport-agnostic (the
     * server filters on it), so it must not follow one channel's health — the
     * private channel's error path re-fires on every rejoin and would oscillate
     * the row against the heartbeat. Same predicate as the heartbeat gate.
     */
    private syncReachabilityStatus(): void {
        this.queueStatusWrite(this.isReachable() ? 'online' : 'offline');
    }

    /**
     * Serialize the channel-callback status writes. They fire from un-awaited
     * callbacks, and inside recreateChannel() a teardown's 'offline' and the
     * fresh join's 'online' land ~100-300ms apart — unordered, 'offline' can win
     * and leave a healthy device undispatchable until the next heartbeat.
     *
     * Not the single writer: updateHeartbeat, registerDevice and setOffline's
     * subprocess write status directly, so this is not total ordering.
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
            // Session for the subprocess — bounded, with a cached fallback.
            // getSession() is not a cheap read: it takes a lock (10s acquire
            // timeout) and refreshes when the token is within ~90s of expiry,
            // POSTing /token with its own ~30s retry budget. On a just-woken
            // machine that outlasts device.ts's 5s force-exit, and then spawnSync
            // never runs and the offline write is lost. The subprocess calls
            // setSession() itself, so a slightly stale access_token is fine.
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

            // process.execPath is the exact Node binary currently running the
            // server. Using it (instead of the bare name 'node') skips PATH
            // resolution entirely, so the update script always runs on the same
            // runtime and can't be shadowed by a different 'node' on PATH.
            const result = spawnSync(process.execPath, [
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
        // setOffline()'s durable write is the final word on `status` from here,
        // so stop the heartbeat and the channel callbacks from racing it. The
        // races that matter: a heartbeat tick firing as the signal arrives, and
        // SIGINT during recreateChannel()'s backoff, where the later join's
        // SUBSCRIBED would queue 'online' after the durable write.
        this.shuttingDown = true;
        // Budget against device.ts's 5s force-exit, worst case:
        //   250 drain + 3x300 leave + 500 session + 3000 spawnSync = 4650ms.
        // In practice only the untrack bound binds — removeChannel/unsubscribe
        // set state='leaving' first, so their leave push resolves inline.
        const LEAVE_BOUND_MS = 300;
        // Drain queued channel-callback writes. Can't drain an in-flight
        // heartbeat PATCH (it doesn't use the chain), but the gate above stops
        // any new one and an in-flight one started earlier.
        await Promise.race([this.statusWriteChain, this.sleep(250)]);
        await Promise.race([this.removeLegacyChannel(), this.sleep(LEAVE_BOUND_MS)]);
        if (this.channel) {
            // Leave presence on the graceful path (socket close covers the abrupt
            // one). Bounded: a half-open socket still reports 'joined', so the
            // push just buffers and would settle via realtime-js's 10s timeout.
            try {
                await Promise.race([
                    this.channel.untrack(),
                    this.sleep(LEAVE_BOUND_MS),
                ]);
                console.debug('[DEBUG] Presence untrack attempted (bounded)');
            } catch { /* best effort */ }
            // Bounded as insurance; unsubscribe() resolves inline in practice.
            await Promise.race([this.channel.unsubscribe(), this.sleep(LEAVE_BOUND_MS)]);
            this.channel = null;
            console.log('✓ Unsubscribed from tool call channel');
        }
    }
}
