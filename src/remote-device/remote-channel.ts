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

/**
 * The device registered, but its realtime channel is not usable — the join
 * failed, or presence was never acknowledged. Distinct from every other
 * registration failure on purpose: this one the socket watchdog can repair, so
 * the caller keeps the process alive, while a failed lookup or a missing row
 * happens before the recreation parameters are stored and nothing can repair it.
 */
export class ChannelUnreachableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ChannelUnreachableError';
    }
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
// Keep Supabase's retry cadence, but jitter every device independently so one
// Realtime disconnect cannot synchronize the whole fleet onto 1s/2s/5s/10s
// reconnect waves. ±50% keeps recovery latency close to the SDK default while
// spreading load across the recovery window.
const REALTIME_RECONNECT_BASE_MS = [1000, 2000, 5000, 10000] as const;
const REALTIME_RECONNECT_FALLBACK_MS = 10000;
// Presence-only failures do not mean broadcast delivery is down: a joined
// channel can still receive doorbells while Presence's DB-backed work is
// degraded. Keep a previously-proven capability for one normal heartbeat
// interval before falling back to the 15s legacy tier, avoiding a 20x heartbeat
// write-rate jump during short provider incidents.
const PRESENCE_WITHDRAW_GRACE_MS = 5 * 60 * 1000;
// Cap on a recreate's rebuild step so a hung await can't disable the watchdog.
// Must exceed createChannel()'s worst case (~32.25s of jittered presence retries).
const RECREATE_TIMEOUT_MS = 45000;
// Max continuous time in 'joining' before forcing a recreate — a half-open
// socket parks the channel there forever, and a genuine join settles in ~10s.
const JOINING_WEDGE_TIMEOUT_MS = 30000;
// Backstop for a half-open socket where 'joined' never changes and realtime-js's
// own heartbeat-close never completes. ~3x the 25s heartbeat interval.
const HEARTBEAT_STALE_TIMEOUT_MS = 75000;
// Fixed cadence for our own token refresh, independent of auth-js's internal
// ticker (disabled in initialize()) — see the clock-skew comment below for why.
const TOKEN_REFRESH_INTERVAL_MS = 45 * 60 * 1000;
// Below this, skew is noise — leave Date.now untouched. Above it, correct.
const CLOCK_SKEW_CORRECTION_THRESHOLD_MS = 5 * 60 * 1000;
// Failed recreates before withdrawing transport_broadcast_v1 — keeping it while
// unable to join leaves the server dispatching calls this device can't
// receive. Not lower than 3: ordinary half-open recovery legitimately costs 2.
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
// Reconnect recovery is a safety net, not the primary transport. Bound each
// scan so a pathological backlog cannot turn one reconnect into an unbounded
// burst of REST claims/tool executions.
const PENDING_RECOVERY_BATCH_SIZE = 100;

function jitterAround(baseMs: number, random: () => number): number {
    const sample = Math.max(0, Math.min(1, random()));
    return Math.max(1, Math.round(baseMs * (0.5 + sample)));
}

/** Jittered version of realtime-js's default 1s/2s/5s/10s stepped backoff. */
export function realtimeReconnectDelayMs(tries: number, random: () => number = Math.random): number {
    const attempt = Math.max(1, Math.floor(tries || 1));
    const baseMs = REALTIME_RECONNECT_BASE_MS[attempt - 1] ?? REALTIME_RECONNECT_FALLBACK_MS;
    return jitterAround(baseMs, random);
}

/** Preserve Presence's existing 500ms-per-attempt retry shape, but desynchronize it. */
export function presenceRetryDelayMs(failedAttempt: number, random: () => number = Math.random): number {
    const attempt = Math.max(1, Math.floor(failedAttempt || 1));
    return jitterAround(500 * attempt, random);
}

// auth-js compares token expiry against this device's own Date.now(), with no
// clock-skew tolerance — a fast clock treats every fresh token as expired and
// refreshes forever (confirmed in prod on one device, via at least 3 separate
// check sites, not all gated by autoRefreshToken).
// Rather than chase each check, fix the shared input: every Supabase response
// carries a `Date` header (RFC 7231, the server's own clock), so a fetch
// wrapper passed via `global.fetch` corrects Date.now for this process off of
// that, continuously — covers every current and future check without needing
// to know where they live. Also shifts capture.ts telemetry timestamps
// (Date.now-based) onto server time, which is desirable: GA4 drops
// future-dated events, so a fast-clock device loses its telemetry otherwise.
// `new Date()` is untouched.
const rawDateNow = Date.now;
let clockOffsetMs = 0;
let clockPatched = false;

export function observeServerDate(dateHeader: string | null): void {
    if (!dateHeader) return;
    const serverMs = Date.parse(dateHeader);
    if (Number.isNaN(serverMs)) return;

    const offsetMs = serverMs - rawDateNow();
    if (Math.abs(offsetMs) <= CLOCK_SKEW_CORRECTION_THRESHOLD_MS) {
        if (clockPatched) {
            Date.now = rawDateNow;
            clockPatched = false;
        }
        return;
    }

    clockOffsetMs = offsetMs;
    if (!clockPatched) {
        Date.now = () => rawDateNow() + clockOffsetMs;
        clockPatched = true;
        console.warn(`⚠️ Device clock skewed ~${Math.round(offsetMs / 1000)}s from Supabase — correcting for this process`);
        captureRemote('remote_channel_clock_skew_corrected', { offsetMs }).catch(() => { });
    }
}

async function clockAwareFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const response = await fetch(input, init);
    observeServerDate(response.headers.get('date'));
    return response;
}

export class RemoteChannel {
    private client: SupabaseClient | null = null;
    private channel: RealtimeChannel | null = null;
    private heartbeatInterval: NodeJS.Timeout | null = null;
    private connectionCheckInterval: NodeJS.Timeout | null = null;
    /** Device the heartbeat timer maintains; null = stopped, so re-arm is inert. */
    private heartbeatDeviceId: string | null = null;
    // Single-slot queue keeping concurrent `status` PATCHes in order.
    private statusWriteChain: Promise<void> = Promise.resolve();
    /**
     * Answers whether the local execution child is alive. Default yes, so a
     * RemoteChannel used without a device (tests, other callers) behaves as
     * before; MCPDevice installs the real probe.
     */
    private localExecutorProbe: () => boolean = () => true;
    /** Tokens from the last setSession / TOKEN_REFRESHED, for setOffline(). */
    private lastKnownSession: { access_token: string; refresh_token: string | null } | null = null;
    /** Notified when auth-js rotates the session; the device persists it. */
    private sessionRefreshedHandler: ((session: AuthSession) => void) | null = null;
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
    /** Monotonic start of a Presence-only degradation while broadcast remains joined. */
    private presenceFailureStartedAt: number | null = null;
    /** Re-entrancy guard: on a wedged socket each track() buffers for the full
     * 10s push timeout, so 10s health ticks would stack pushes. */
    private isTrackingPresence = false;

    // Track last device status to prevent duplicate log messages
    private lastDeviceStatus: 'online' | 'offline' = 'offline';

    // Track last channel state for debug logging
    private lastChannelState: string | null = null;

    private reconnectAttempt = 0;        // recreates since the last success
    private isRecreatingChannel = false; // re-entrancy guard
    private joiningSince: number | null = null; // start of an unbroken 'joining' run (performance.now())
    /** Last confirmed proof of life (SUBSCRIBED or heartbeat 'ok'); null until the
     * first one lands. On performance.now(), not Date.now(): the clock-skew
     * correction above can (un)patch Date.now mid-run, jumping wall-clock math by
     * the whole offset — a backward jump would suppress stale detection for as
     * long as the offset. Same for joiningSince. */
    private lastHeartbeatOkAt: number | null = null;
    private heartbeatListenerRegistered = false;
    /** Our own fixed-cadence auth refresh timer — see TOKEN_REFRESH_INTERVAL_MS. */
    private tokenRefreshInterval: NodeJS.Timeout | null = null;

    private _user: User | null = null;
    get user(): User | null { return this._user; }


    initialize(url: string, key: string): void {
        // autoRefreshToken:false — we drive refresh ourselves (startTokenRefresh(),
        // see TOKEN_REFRESH_INTERVAL_MS) instead of auth-js's local-clock-driven
        // ticker. clockAwareFetch — see the clock-skew correction block above.
        this.client = createClient(url, key, {
            auth: { autoRefreshToken: false },
            global: { fetch: clockAwareFetch },
            realtime: {
                reconnectAfterMs: realtimeReconnectDelayMs,
                // supabase-js's resolver ends in `?? supabaseKey`, so after SIGNED_OUT
                // the socket silently re-pins to the anon key and every private-channel
                // join is refused. Overriding under `realtime` (not the top-level
                // `accessToken`, which turns client.auth into a throwing Proxy).
                // getSession() may refresh on-demand when the token reads expired —
                // that check is clock-skew-safe now (see clockAwareFetch above).
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
        if (!this.heartbeatListenerRegistered) {
            this.heartbeatListenerRegistered = true;
            try {
                (this.client as any).realtime?.onHeartbeat?.((status: string) => {
                    if (status === 'ok') this.lastHeartbeatOkAt = performance.now();
                });
            } catch { /* no onHeartbeat on this client version: staleness check stays inert */ }
        }
    }

    /**
     * Teach the channel how to ask whether the local executor is alive.
     * `status` is a claim that this device will run a tool call right now, and
     * a joined channel alone cannot support that claim - issue #4.
     */
    setLocalExecutorProbe(probe: () => boolean) {
        this.localExecutorProbe = probe;
    }

    /**
     * Register a callback fired when auth-js rotates the session. auth-js
     * rotates the refresh token on every refresh and the previous one is spent,
     * so a config written once at startup replays a dead token on the next
     * restart and the device demands browser authorization again.
     */
    onSessionRefreshed(handler: (session: AuthSession) => void) {
        this.sessionRefreshedHandler = handler;
    }

    async setSession(session: AuthSession): Promise<{ error: any }> {
        if (!this.client) throw new Error('Client not initialized');
        console.debug('[DEBUG] RemoteChannel.setSession() called, has refresh_token:', !!session.refresh_token);
        // setSession() already fetches the user from GoTrue (or refreshes), so no getUser() after it.
        const { data: { user }, error } = await this.client.auth.setSession({
            access_token: session.access_token,
            refresh_token: session.refresh_token || ''
        });

        if (error) {
            console.error('[DEBUG] Failed to set session:', error.message);
            await captureRemote('remote_channel_set_session_error', { error });
            return { error };
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
                    // Memory alone is not enough: the token we just replaced is
                    // spent, so whatever is on disk is now unusable.
                    // Hand over the session we were just given. A listener that
                    // re-read it could find a sign-out instead and persist that.
                    this.sessionRefreshedHandler?.({
                        access_token: newSession.access_token,
                        refresh_token: newSession.refresh_token ?? null,
                    } as AuthSession);
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
            console.debug('[DEBUG] Registering device as offline until the channel proves otherwise');
            // Neither half of this row may claim reachability yet. transport_
            // broadcast_v1 is NOT set here: the server treats it as binding, so
            // it is written only once presence is proven. `status` is the same
            // promise in the other notation — dispatch picks its target by it,
            // then fails the call fast for the missing capability, so a row
            // marked online before the channel is up hands every call in that
            // window to a device with no delivery path. SUBSCRIBED writes
            // 'online'; presence writes the capability.
            const { error: registrationError } = await this.updateDevice(existingDevice.id, {
                status: 'offline',
                last_seen: new Date().toISOString(),
                capabilities: this.capabilitiesPayload(false),
                device_name: deviceName
            });

            // updateDevice() logs and returns its error rather than throwing.
            // Opening the channel anyway would leave a row that still says
            // whatever the last run left there — including 'online' — while
            // nothing here can correct it: the channel's own error path queues
            // an offline write, and setOnlineStatus() only logs when that write
            // fails too. Stop before the channel instead.
            if (registrationError) {
                throw new Error(`Failed to register device: ${registrationError.message}`);
            }

            // Store parameters for channel recreation
            this.deviceId = existingDevice.id;
            this.deviceName = deviceName;
            this.onToolCall = onToolCall;

            console.debug(`⏳ Subscribing to tool call channel...`);

            // Create and subscribe to the channel
            console.debug('[DEBUG] Calling createChannel()');

            // Let a failed join reach the caller. createChannel() resolves only
            // once the channel is joined AND presence is published — the two
            // things dispatch needs — so swallowing its rejection here was what
            // let device.ts print "Device ready" over a device that cannot
            // receive a single command. The caller decides what to do with it;
            // it is not fatal, the socket watchdog keeps retrying.
            await this.createChannel();

        } else {
            console.error(`   - ❌ Device not found: ${currentDeviceId}`);
            await captureRemote('remote_channel_register_device_error', { error: 'Device not found', deviceId: currentDeviceId });
            throw new Error(`Device not found: ${currentDeviceId}`);
        }
    }

    /**
     * Publish presence, retrying a non-'ok' result — track() resolves with a
     * status rather than rejecting, and absent presence reads as offline on the
     * dashboard. `presenceTracked` lets the health check retry later.
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
        // A fresh attempt starts from "not proven", so a leftover true from an
        // earlier join cannot keep the device counting as reachable while this
        // one is still deciding.
        this.presenceTracked = false;

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
                // `presenceTracked` is not "track() said ok" — isReachable()
                // reads it as "this device receives commands", and the heartbeat
                // consults isReachable() directly rather than waiting for the
                // sequence below. Raising it here let a heartbeat firing while
                // these writes were in flight assert `online` over a row with no
                // capability recorded: the very state this is meant to remove.
                // So it is raised last, when every claim it makes is already true.
                //
                // Both writes have to land. Supabase reports a refused write in
                // the result rather than by throwing, and a device whose row
                // records neither the capability nor `online` is exactly as
                // undispatchable as one that never published presence. The
                // health check retries presence while this stays false, which is
                // the way back.
                const capabilityWritten = await this.setTransportCapable(true);
                // Strictly after, never alongside: `online` may be claimed only
                // where the capability is already advertised, or the row lands
                // back in the state this whole change is about.
                // Not syncReachabilityStatus(): its predicate reads presenceTracked,
                // and that flag is deliberately still false here - it is raised last,
                // once these writes have landed, so a heartbeat cannot advertise the
                // row mid-sequence. Both halves the predicate asks about are already
                // known at this point: the channel is joined and presence was just
                // acknowledged. The only open question is the local executor, so ask
                // that directly - a joined, present device whose executor is dead must
                // not be advertised either.
                const statusWritten = capabilityWritten
                    ? await this.queueStatusWrite(this.localExecutorProbe() ? 'online' : 'offline')
                    : false;
                if (!capabilityWritten || !statusWritten) {
                    console.error('❌ Presence published but the device row could not be updated — not ready');
                    captureRemote('remote_channel_readiness_write_failed', {
                        capabilityWritten, statusWritten
                    }).catch(() => { });
                    return;
                }

                this.presenceTracked = true;
                this.presenceFailureStartedAt = null;
                console.log(`👋 Presence tracked (device ${this.deviceId} visible as online)`);
                // Reconnect attempts preceding this join (0 on a first join).
                captureRemote('remote_channel_presence_tracked', { recoveredAfterAttempts: recovered }).catch(() => { });

                // Broadcast is only a wake-up signal; mcp_remote_calls is the
                // durable queue. A call inserted while this socket was briefly
                // disconnected can miss its one new_call doorbell and otherwise
                // stay pending until the server reaper times it out. Drain that
                // durable backlog whenever the channel becomes genuinely usable.
                // Fire-and-forget so readiness does not wait on backlog recovery;
                // each row still goes through the atomic pending -> executing
                // claim, so a late/duplicate doorbell can safely race this scan.
                this.recoverPendingCalls().catch((error: any) => {
                    console.error('[DEBUG] Pending call recovery failed:', error?.message);
                });
                return;
            }

            console.error(`❌ Presence track not acknowledged (${status}) — attempt ${attempt}/${attempts}`);
            if (attempt < attempts) await this.sleep(presenceRetryDelayMs(attempt));
        }

        this.presenceTracked = false;
        captureRemote('remote_channel_presence_track_error', { attempts }).catch(() => { });

        // Presence is an observer signal, not the delivery path. If this device
        // already proved broadcast capability and the channel is still joined,
        // keep that capability through a short provider-side Presence incident
        // instead of immediately switching to the 15s legacy heartbeat tier.
        // The 10s health check keeps retrying Presence; a success clears the
        // timer. Genuine channel failure is handled separately by
        // recreateChannel(), which still withdraws after 3 failed recreates.
        if (this.transportCapableWritten === true && this.channel?.state === 'joined') {
            const now = performance.now();
            if (this.presenceFailureStartedAt === null) this.presenceFailureStartedAt = now;
            const degradedForMs = now - this.presenceFailureStartedAt;
            if (degradedForMs < PRESENCE_WITHDRAW_GRACE_MS) {
                console.warn(
                    `⚠️ Presence unavailable for ${Math.round(degradedForMs / 1000)}s — ` +
                    `retaining broadcast capability during ${PRESENCE_WITHDRAW_GRACE_MS / 1000}s grace`
                );
                return;
            }
        }

        this.presenceFailureStartedAt = null;
        console.error('❌ Presence track remained unavailable — withdrawing broadcast capability');
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
     * reachable that way — the server fails dispatch fast without it and picks
     * the offline-sweep tier from it, so every change must re-arm the heartbeat.
     */
    private async setTransportCapable(capable: boolean): Promise<boolean> {
        if (!this.client || !this.deviceId) return false;
        if (this.transportCapableWritten === capable) return true; // no redundant writes
        try {
            const capabilities = this.capabilitiesPayload(capable);
            const { error } = await this.client
                .from('mcp_devices')
                .update({ capabilities })
                .eq('id', this.deviceId);
            if (error) {
                console.error('[DEBUG] Failed to update transport capability:', error.message);
                return false;
            }
            this.transportCapableWritten = capable;
            console.debug(`[DEBUG] Transport capability set to ${capable ? 'broadcast_v1' : 'withdrawn'}`);
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
            return false;
        }
        return true;
    }

    /** Create and subscribe the private channel (initial join and recreation). */
    private createChannel(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.client || !this.user?.id || !this.onToolCall || !this.deviceId) {
                // deviceId is the presence KEY; a null key gets a random one and
                // the dashboard's lookup by device id silently misses.
                console.debug('[DEBUG] createChannel() failed - missing prerequisites');
                return reject(new Error('Client not initialized or missing subscription parameters'));
            }

            // Private per-user channel: new_call doorbells + this device's
            // Presence, keyed by device id.
            const channelName = `user:${this.user.id}`;
            console.debug(`[DEBUG] Creating channel: ${channelName}`);
            this.channel = this.client.channel(channelName, {
                config: {
                    private: true,
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
                        this.lastHeartbeatOkAt = performance.now(); // a fresh join is proof of life too
                        console.log(`✅ Channel subscribed${recovered > 0 ? ` (recovered after ${recovered} attempt${recovered === 1 ? '' : 's'})` : ''}`);
                        // A join is only half of what dispatch needs. The other
                        // half is presence, which writes the capability the
                        // server checks — and when every track() is refused,
                        // trackPresenceInner() withdraws the capability and
                        // returns normally. Resolving here regardless left the
                        // row online with the capability withdrawn: the exact
                        // state the server refuses as not_broadcast_capable.
                        // `status` is written on the same event as the
                        // capability, in trackPresenceInner, so the two can
                        // never disagree.
                        this.trackPresenceWithRetry(recovered)
                            .catch(() => { /* logged inside */ })
                            .finally(() =>
                                this.presenceTracked
                                    ? resolve()
                                    : reject(new ChannelUnreachableError(
                                        'channel joined but presence was never acknowledged, so no command can be delivered'
                                    ))
                            );
                    } else if (status === 'CHANNEL_ERROR') {
                        // CHANNEL_ERROR is the only status carrying a real error message.
                        console.error(`❌ Channel error: ${err?.message || 'unknown'} — ${this.connState()}`);
                        this.presenceTracked = false;
                        this.syncReachabilityStatus();
                        // Fires on ordinary network faults too — filter on the
                        // error text to isolate an 008 misconfiguration.
                        captureRemote('remote_channel_subscription_error', { error: err?.message || 'Channel error' }).catch(() => { });
                        reject(new ChannelUnreachableError(err?.message || 'failed to subscribe to the tool call channel'));
                    } else if (status === 'TIMED_OUT') {
                        console.error(`⏱️ Channel subscription timed out, Reconnecting... — ${this.connState()}`);
                        this.syncReachabilityStatus();
                        captureRemote('remote_channel_subscription_timeout', { attempt: this.reconnectAttempt }).catch(() => { });
                        reject(new ChannelUnreachableError('tool call channel subscription timed out'));
                    } else if (status === 'CLOSED') {
                        // Settle the promise so an in-flight recreateChannel() can't await
                        // forever (which would wedge the re-entrancy guard / watchdog).
                        console.warn(`⚠️ Channel closed — ${this.connState()}`);
                        this.syncReachabilityStatus();
                        reject(new ChannelUnreachableError('tool call channel closed during subscribe'));
                    }
                });
        });
    }

    /**
     * Recover calls whose Realtime doorbell was missed while this device was
     * disconnected. Broadcast provides the fast path; the DB row is the source
     * of truth. Only still-live pending rows for this device are considered.
     *
     * The follow-up onDoorbell() call performs the existing conditional claim,
     * which makes this safe against a doorbell arriving at the same time.
     */
    private async recoverPendingCalls(): Promise<void> {
        if (!this.client || !this.deviceId || !this.isReachable()) return;

        // Date.now() is deliberately used here: this process may patch it from
        // Supabase's Date header to correct a badly skewed device clock.
        const now = new Date(Date.now()).toISOString();
        const { data: pending, error } = await this.client
            .from('mcp_remote_calls')
            .select('id,device_id')
            .eq('device_id', this.deviceId)
            .eq('status', 'pending')
            .gt('timeout_at', now)
            .order('created_at', { ascending: true })
            .limit(PENDING_RECOVERY_BATCH_SIZE);

        if (error) {
            console.error('[DEBUG] Failed to query pending calls after reconnect:', error.message);
            await captureRemote('remote_channel_pending_recovery_error', { error });
            return;
        }

        if (!pending?.length) return;

        console.log(`♻️  Recovering ${pending.length} pending remote call${pending.length === 1 ? '' : 's'} after reconnect`);
        captureRemote('remote_channel_pending_recovery', {
            pending_count: pending.length,
            batch_capped: pending.length === PENDING_RECOVERY_BATCH_SIZE,
        }).catch(() => { });

        // Claim quickly; dispatchToolCall() does not await tool execution, so
        // this loop serializes only the small REST claim operations.
        for (const row of pending) {
            if (!this.isReachable()) break;
            await this.onDoorbell({
                call_id: row.id,
                device_id: row.device_id,
            });
        }
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
     * Handle a 'new_call' doorbell. It carries ids only; one conditional update
     * claims the row (pending -> executing) and returns it, and it is handed to
     * device.ts marked as claimed.
     */
    private async onDoorbell(payload: any): Promise<void> {
        const callId = payload?.call_id;
        if (!callId) return;
        if (payload?.device_id !== this.deviceId) {
            console.debug('[DEBUG] Ignoring doorbell for different device');
            return;
        }

        // Not a telemetry event on purpose: ~126k/day in prod. Transport usage
        // is already segmentable server-side via metadata.transport.
        console.debug('[DEBUG] Doorbell received for call:', callId);

        if (!this.client) return;

        // Retry on transient failures (a REST blip while the socket stays
        // healthy). This claim is the only way we learn about a call,
        // so a hiccup must not cost a 5-minute timeout.
        let row: any = null;
        let claimError: any = null;
        for (const delayMs of [0, 500, 1500]) {
            if (delayMs > 0) await this.sleep(delayMs);
            const { data, error } = await this.client
                .from('mcp_remote_calls')
                .update({ status: 'executing' })
                .eq('id', callId)
                .eq('device_id', this.deviceId)
                .eq('status', 'pending')
                .gt('timeout_at', new Date(Date.now()).toISOString())
                .select('*');
            if (!error) {
                row = data?.[0] ?? null;
                break;
            }
            // Left set on purpose: a later clean empty result may still mean our
            // own attempt committed, so the read-back below must run.
            claimError = error;
            console.debug(`[DEBUG] Doorbell claim attempt failed for ${callId}: ${error.message} — retrying`);
        }

        if (row) {
            this.dispatchToolCall({ new: row, claimed: true });
            return;
        }
        if (!claimError) {
            // Claimed by a duplicate doorbell or another process, or cleaned up.
            console.debug('[DEBUG] Doorbell call already claimed or gone:', callId);
            await captureRemote('remote_channel_doorbell_claim_no_row', { call_id: callId });
            return;
        }

        await captureRemote('remote_channel_mark_call_executing_error', { error: claimError });

        // A failed claim may never have reached the database, so read the row
        // back: still 'pending' means nobody holds it and it can be delivered.
        const { data: current, error } = await this.client
            .from('mcp_remote_calls')
            .select('*')
            .eq('id', callId)
            .eq('device_id', this.deviceId)
            .maybeSingle();
        if (error) {
            console.error(`[DEBUG] Doorbell row fetch failed for ${callId} after claim errors:`, error.message);
            await captureRemote('remote_channel_doorbell_fetch_error', { error });
            return;
        }
        if (
            current?.status === 'pending'
            && current.timeout_at
            && new Date(current.timeout_at).getTime() > Date.now()
        ) {
            // No claim landed; device.ts claims it. Do not hand an expired
            // side-effecting call to the executor while it races the reaper.
            this.dispatchToolCall({ new: current });
        } else {
            // 'executing' reads the same whether our own claim committed with its
            // response lost or another process holding this device_id won it, and
            // the row carries no claimant. Running it on that guess executes a
            // side-effecting tool twice; skipping costs one call its timeout, which
            // is what a failed doorbell read already cost before the claim path.
            console.debug('[DEBUG] Doorbell call already claimed or gone:', callId);
            await captureRemote('remote_channel_doorbell_claim_unresolved', {
                call_id: callId,
                status: current?.status ?? null,
            });
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

            // 'joined' is a cached string, not proof of a live socket. Cross-check
            // against the last confirmed heartbeat reply.
            if (this.lastHeartbeatOkAt !== null) {
                const staleMs = performance.now() - this.lastHeartbeatOkAt;
                if (staleMs > HEARTBEAT_STALE_TIMEOUT_MS) {
                    console.debug(`[DEBUG] ⚠️ Channel reads 'joined' but no confirmed heartbeat in ${Math.round(staleMs / 1000)}s - forcing recreate — ${this.connState()}`);
                    captureRemote('remote_channel_heartbeat_stale', { staleMs, attempt: this.reconnectAttempt });
                    this.recreateChannel();
                    return;
                }
            }

            // Self-heal a failed presence publish: the channel is up, so nothing
            // else will ever retry (SUBSCRIBED won't fire again). Until it
            // lands the dashboard shows this device offline, and if track()
            // already failed its retries the capability is withdrawn too, so
            // the server fails every dispatch to it fast.
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
            const now = performance.now();
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
            // 'joined' alone isn't proof — only bail out when we don't already
            // know the heartbeat is stale (this recreate may have been triggered
            // by exactly that).
            const heartbeatStale = this.lastHeartbeatOkAt !== null
                && (performance.now() - this.lastHeartbeatOkAt) > HEARTBEAT_STALE_TIMEOUT_MS;
            if (this.channel?.state === 'joined' && !heartbeatStale) {
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

                // FIX (core): force a brand-new WebSocket. After idle / wifi-loss the socket can
                // be HALF-OPEN (readyState OPEN but dead); reusing it made every join TIME_OUT
                // forever. disconnect() drops it so the next subscribe() dials a fresh one.
                try { await (this.client as any).realtime?.disconnect?.(); } catch { /* best effort */ }

                // ...but disconnect() is not synchronous from connect()'s point
                // of view: it parks _connectionState in 'disconnecting' and
                // _teardownConnection() nulls the conn.onclose that would clear
                // it, so only an internal ~100ms fallback timer does. connect()
                // early-returns for that whole window, so rebuilding here makes
                // subscribe()'s socket.connect() a silent no-op and the channel
                // sits in 'joining' until the 10s join timeout — a wasted first
                // recreate. Wait for the state to settle before rebuilding.
                await this.waitForSocketSettled();

                console.debug('[DEBUG] Calling createChannel() for recreation');
                await this.createChannel();
            }, RECREATE_TIMEOUT_MS, 'recreateChannel');
        } catch (err: any) {
            captureRemote('remote_channel_recreate_error', { errMsg: err?.message, attempt: this.reconnectAttempt });
            console.debug(`[DEBUG] Channel recreation failed: ${err?.message} — ${this.connState()}`);
            // Sustained failure: stop promising a transport we can't deliver, so
            // dispatch fails fast instead of every call waiting out the timeout.
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
            .gt('timeout_at', new Date(Date.now()).toISOString())
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
     * Reachable means all of it is true at once: the private channel is
     * joined, this device has published its presence, and the local executor
     * answers. The server needs the first two before it will dispatch, and a
     * healthy channel on a device whose executor is dead is the false-online
     * state issue #4 was opened for. Gates the heartbeat and `status`.
     */
    private isReachable(): boolean {
        return this.channel?.state === 'joined'
            && this.presenceTracked
            && this.localExecutorProbe();
    }

    /**
     * Set `status` from actual reachability. `status` is transport-agnostic (the
     * server filters on it), so it must not follow one channel's health — the
     * private channel's error path re-fires on every rejoin and would oscillate
     * the row against the heartbeat. Same predicate as the heartbeat gate.
     *
     * Every transition belongs here rather than calling setOnlineStatus(), which
     * is the write and not the decision. Public so the device can route its
     * recovery transition through the predicate too.
     */
    /** Resolves with whether the row actually took the write. */
    syncReachabilityStatus(): Promise<boolean> {
        return this.queueStatusWrite(this.isReachable() ? 'online' : 'offline');
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
    private queueStatusWrite(status: 'online' | 'offline'): Promise<boolean> {
        // After teardown begins, setOffline() owns the final status write.
        if (this.shuttingDown) {
            console.debug(`[DEBUG] Status write '${status}' suppressed — teardown in progress`);
            return Promise.resolve(false);
        }
        // The chain only sequences the writes; whether one landed goes back
        // to whoever asked, so readiness can depend on it.
        const write = this.statusWriteChain
            .then(() => (this.deviceId ? this.setOnlineStatus(this.deviceId, status) : false))
            .catch((e: any) => {
                console.error('[DEBUG] Status write failed:', e?.message);
                return false;
            });
        this.statusWriteChain = write.then(() => undefined);
        return write;
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
            // stale 'online' — and that row is what dispatch reads. Staying
            // silent lets the sweep do its job.
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
        this.startTokenRefresh();
        console.debug(`[DEBUG] Heartbeat started - connectionCheck: 10s, last_seen: ${this.heartbeatIntervalMs()}ms, tokenRefresh: ${TOKEN_REFRESH_INTERVAL_MS}ms`);
    }

    private async refreshTokenNow(): Promise<void> {
        if (!this.client || this.shuttingDown) return;
        try {
            const { error } = await this.client.auth.refreshSession();
            if (error) {
                console.error('[DEBUG] Manual token refresh failed:', error.message);
                await captureRemote('remote_channel_token_refresh_error', { error });
            } else {
                console.debug('[DEBUG] Manual token refresh ok');
            }
        } catch (error: any) {
            console.error('[DEBUG] Manual token refresh threw:', error?.message);
            await captureRemote('remote_channel_token_refresh_error', { error });
        }
    }

    private startTokenRefresh(): void {
        if (this.tokenRefreshInterval) return; // already running
        this.tokenRefreshInterval = setInterval(() => {
            this.refreshTokenNow().catch(() => { /* logged inside */ });
        }, TOKEN_REFRESH_INTERVAL_MS);
    }

    private stopTokenRefresh(): void {
        if (this.tokenRefreshInterval) {
            clearInterval(this.tokenRefreshInterval);
            this.tokenRefreshInterval = null;
        }
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
        this.stopTokenRefresh();
    }

    /** @returns whether the row actually took the write. */
    async setOnlineStatus(deviceId: string, status: 'online' | 'offline'): Promise<boolean> {
        if (!this.client) return false;

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
            return false;
        } else {
            console.debug(`[DEBUG] Device status set to ${status}`);
        }

        return true;

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
            // never runs and the offline write is lost. The subprocess refreshes
            // an expired access_token itself, so a stale one is fine.
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
                // A lost session's refresh token already failed to refresh;
                // presenting it again can trip GoTrue's reuse detection.
                this.sessionLost ? '' : session.refresh_token || ''
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
        //   250 drain + 2x300 leave + 500 session + 3000 spawnSync = 4350ms.
        // In practice only the untrack bound binds — removeChannel/unsubscribe
        // set state='leaving' first, so their leave push resolves inline.
        const LEAVE_BOUND_MS = 300;
        // Drain queued channel-callback writes. Can't drain an in-flight
        // heartbeat PATCH (it doesn't use the chain), but the gate above stops
        // any new one and an in-flight one started earlier.
        await Promise.race([this.statusWriteChain, this.sleep(250)]);
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
