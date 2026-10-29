import { createClient, SupabaseClient, Session, UserResponse, User, RealtimeChannel } from '@supabase/supabase-js';
import { captureRemote } from '../utils/capture.js';
import { observeTransport } from './transport-telemetry.js';
import { RealtimeHealthTelemetry } from './realtime-health-telemetry.js';
import { rolloutManager } from './rollouts.js';
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
 * failed, or the device row could not be marked ready. Distinct from every other
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

// last_seen cadence. Must stay under the server's 15 min offline sweep and the
// dashboard's ~7 min freshness window for the online dot.
export const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
// Fast recovery for short Wi-Fi blips, but never retry every 10 seconds forever.
// Prolonged provider incidents must not keep the entire device fleet joining.
// Independent jitter spreads retry work; full jitter applies at attempt >= 5.
const REALTIME_RECONNECT_BASE_MS = [1000, 2000, 5000, 10000, 20000, 40000, 80000, 120000] as const;
const REALTIME_RECONNECT_FALLBACK_MS = 120000;
const WATCHDOG_RECREATE_MAX_BACKOFF_MS = 120000;
// Presence is best effort (dashboard only): a failed track() waits this long,
// doubling, before the next one, since a track() timeout can end the channel.
const PRESENCE_RETRY_BASE_MS = 5 * 60 * 1000;
const PRESENCE_RETRY_MAX_MS = 60 * 60 * 1000;
// Failed readiness writes are retried sooner: dispatch waits on them.
const READINESS_RETRY_BASE_MS = 5_000;
const READINESS_RETRY_MAX_MS = 60_000;
// Cap on a recreate's rebuild step so a hung await can't disable the watchdog.
// Must exceed createChannel()'s worst case: the join plus its status write,
// queued behind the teardown's 'offline' (~30s).
const RECREATE_TIMEOUT_MS = 45000;
// Upper bound on the persistent unready-join budget. Anything >= 8 already
// selects the 120s SDK tier; the cap only keeps the counter meaningful.
const MAX_UNREADY_JOIN_BUDGET = 16;
// A channel that has stayed joined this long, with a heartbeat confirmed after
// the join, is a working broadcast path even if readiness is still pending.
// Its join no longer counts toward reconnect backoff. Comfortably longer than
// a join->error cycle (~10-30s) and covers at least four 25s heartbeats.
const STABLE_BROADCAST_RESET_MS = 120_000;
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
// Cap on one status write to this device's row, after which it is aborted. A
// PATCH sent down a half-open connection is otherwise answered only by fetch's
// own 300 s headers timeout, and the write queue behind it, readiness
// included, waits as long.
const DEVICE_ROW_WRITE_TIMEOUT_MS = 10_000;
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

/** Exponential-ish SDK backoff. Attempts 1-4 preserve short recovery latency. */
export function realtimeReconnectDelayMs(tries: number, random: () => number = Math.random): number {
    const attempt = Math.max(1, Math.floor(tries || 1));
    const baseMs = REALTIME_RECONNECT_BASE_MS[attempt - 1] ?? REALTIME_RECONNECT_FALLBACK_MS;
    if (attempt <= 4) return jitterAround(baseMs, random);
    // Full jitter is deliberately independent per device; floor avoids an immediate tight retry.
    return Math.max(1000, Math.round(baseMs * Math.max(0, Math.min(1, random()))));
}

/** Watchdog must not defeat the SDK's slower persistent-failure backoff. */
export function watchdogRecreateDelayMs(tries: number, random: () => number = Math.random): number {
    const attempt = Math.max(1, Math.floor(tries || 1));
    const baseMs = Math.min(WATCHDOG_RECREATE_MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempt, 7));
    return jitterAround(baseMs, random);
}

/** Doubling step after `failures` consecutive failures, capped at `maxMs`. */
function backoffStepMs(failures: number, baseMs: number, maxMs: number): number {
    const attempt = Math.max(1, Math.floor(failures || 1));
    return Math.min(maxMs, baseMs * 2 ** Math.min(attempt - 1, 10));
}

/**
 * Wait before the next track() after failed ones, across SDK rejoins and
 * recreates. Never shorter than the step; up to 50% extra spreads the fleet.
 */
export function presenceRecoveryDelayMs(failures: number, random: () => number = Math.random): number {
    const stepMs = backoffStepMs(failures, PRESENCE_RETRY_BASE_MS, PRESENCE_RETRY_MAX_MS);
    return Math.round(stepMs * (1 + 0.5 * Math.max(0, Math.min(1, random()))));
}

/** Full-jitter wait before retrying the readiness write after failed ones. */
function readinessRetryDelayMs(failures: number, random: () => number = Math.random): number {
    const stepMs = backoffStepMs(failures, READINESS_RETRY_BASE_MS, READINESS_RETRY_MAX_MS);
    return Math.max(1_000, Math.round(stepMs * Math.max(0, Math.min(1, random()))));
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
    /** The current join's status write landed: dispatchable. Gates the
     * heartbeat, so only that write first marks the row online. */
    private channelReady = false;
    /** Readiness write in flight. Cleared on every join, so each join writes its own. */
    private readinessInFlight: Promise<boolean> | null = null;
    private consecutiveReadinessFailures = 0;
    private nextReadinessAttemptAt = 0; // monotonic
    /** Presence published on the current join. Dashboard only; never gates dispatch. */
    private presenceTracked = false;
    /** Re-entrancy guard: on a wedged socket each track() buffers for the full
     * 10s push timeout, so 10s health ticks would stack pushes. */
    private isTrackingPresence = false;
    // The SDK resets its rejoin timer on *every* SUBSCRIBED, even if the join
    // dies before it is ready. Count such joins across SDK/channel recreation.
    // Reset once the readiness write succeeds.
    private consecutiveUnreadyJoins = 0;
    private consecutivePresenceFailures = 0;
    private nextPresenceAttemptAt = 0; // monotonic; independent of Date.now skew correction
    /** performance.now() of the latest SUBSCRIBED; null while not joined. */
    private joinedAt: number | null = null;

    /** SDK channel and socket timers share reconnectAfterMs. The persistent
     * unready-join budget prevents a series of partial successes restarting at 1s. */
    private reconnectDelayMs(tries: number, random: () => number = Math.random): number {
        return realtimeReconnectDelayMs(Math.max(tries, this.consecutiveUnreadyJoins), random);
    }
    private readonly realtimeHealth = new RealtimeHealthTelemetry((window) => {
        captureRemote('remote_realtime_health_window', window).catch(() => {});
    });

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
                reconnectAfterMs: (tries: number) => this.reconnectDelayMs(tries),
                // supabase-js's resolver ends in `?? supabaseKey`, so after SIGNED_OUT
                // the socket silently re-pins to the anon key and every private-channel
                // join is refused. Overriding under `realtime` (not the top-level
                // `accessToken`, which turns client.auth into a throwing Proxy).
                accessToken: () => this.getAccessToken(),
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
            // Without a session the 30-minute rollouts request can only be refused
            rolloutManager.stopRefresh();

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

    /**
     * The session's current access token, for the realtime socket and the
     * device's own requests. getSession() may refresh on-demand when the token
     * reads expired — that check is clock-skew-safe now (see clockAwareFetch
     * above). Without a session it falls back to the last token known, and
     * without that it is null, never the anon key.
     */
    async getAccessToken(): Promise<string | null> {
        try {
            const { data } = await this.client!.auth.getSession();
            if (data.session?.access_token) return data.session.access_token;
        } catch {
            /* fall through to the cached token */
        }
        return this.lastKnownSession?.access_token ?? null;
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
            // The row may not claim reachability yet: dispatch picks its target
            // by `status`, so a row marked online before the channel is up hands
            // every call in that window to a device with no delivery path.
            // SUBSCRIBED writes 'online'.
            const { error: registrationError } = await this.updateDevice(existingDevice.id, {
                status: 'offline',
                last_seen: 'now',
                capabilities: this.capabilitiesPayload(),
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
            this.realtimeHealth.setDevice(existingDevice.id);
            this.deviceName = deviceName;
            this.onToolCall = onToolCall;

            console.debug(`⏳ Subscribing to tool call channel...`);

            // Create and subscribe to the channel
            console.debug('[DEBUG] Calling createChannel()');

            // Let a failed join reach the caller. createChannel() resolves only
            // once the channel is joined AND the device row says so — the two
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
     * Mark this join dispatchable by writing `status`. The write has to land —
     * Supabase reports a refused write in the result rather than by throwing.
     * The health check retries on its own cooldown.
     */
    private markChannelReady(): Promise<boolean> {
        if (this.readinessInFlight) return this.readinessInFlight;
        const result = this.markChannelReadyInner().finally(() => {
            if (this.readinessInFlight === result) this.readinessInFlight = null;
        });
        this.readinessInFlight = result;
        return result;
    }

    private async markChannelReadyInner(): Promise<boolean> {
        const channel = this.channel;
        if (!channel || channel.state !== 'joined') return false;

        // Queued while the channel is joined, so a drop's 'offline' queues
        // behind it and lands last. A dead local executor is written as
        // offline even on a healthy channel.
        const statusWritten = await this.queueStatusWrite(this.localExecutorProbe() ? 'online' : 'offline');
        // A replaced channel, or one that dropped meanwhile, decides for itself;
        // the drop's 'offline' and the rejoin's own write are queued behind this one.
        if (this.channel !== channel || channel.state !== 'joined') return false;

        if (!statusWritten) {
            console.error('❌ Channel joined but the device row could not be updated — not ready');
            // Status writes land in order, so this result is newer than any
            // earlier join's success: the row may say offline now.
            this.channelReady = false;
            this.realtimeHealth.record('readiness_write_failures');
            this.consecutiveReadinessFailures++;
            this.nextReadinessAttemptAt = performance.now() +
                readinessRetryDelayMs(this.consecutiveReadinessFailures);
            captureRemote('remote_channel_readiness_write_failed', {}).catch(() => { });
            return false;
        }

        this.channelReady = true;
        this.consecutiveUnreadyJoins = 0;
        this.consecutiveReadinessFailures = 0;
        this.nextReadinessAttemptAt = 0;
        console.log(`✅ Device ready (device ${this.deviceId})`);

        // Broadcast is only a wake-up signal; mcp_remote_calls is the durable
        // queue. Drain calls whose doorbell was missed while disconnected. Each
        // row still goes through the atomic pending -> executing claim.
        this.recoverPendingCalls().catch((error: any) => {
            console.error('[DEBUG] Pending call recovery failed:', error?.message);
        });
        return true;
    }

    /**
     * Publish presence for the dashboard. Best effort: one track() per call,
     * no effect on readiness, and a growing cooldown after each failure — a
     * track() timeout on the server can end the whole channel, and every
     * rejoin would otherwise publish again.
     */
    private async trackPresence(recovered: number): Promise<void> {
        if (this.isTrackingPresence || this.presenceInCooldown()) return;
        const channel = this.channel;
        if (!channel || channel.state !== 'joined') return;

        this.isTrackingPresence = true;
        this.realtimeHealth.record('presence_attempts');
        let status: string;
        try {
            status = await channel.track({
                device_id: this.deviceId,
                device_name: this.deviceName,
                app_version: VERSION,
                platform: process.platform
            });
        } catch (trackErr: any) {
            status = `threw: ${trackErr?.message}`;
        } finally {
            this.isTrackingPresence = false;
        }

        if (status === 'ok') {
            // Presence dies with the channel that published it; a new one publishes its own.
            if (this.channel !== channel) return;
            this.realtimeHealth.record('presence_successes');
            this.presenceTracked = true;
            this.consecutivePresenceFailures = 0;
            this.nextPresenceAttemptAt = 0;
            console.log(`👋 Presence tracked (device ${this.deviceId})`);
            captureRemote('remote_channel_presence_tracked', { recoveredAfterAttempts: recovered }).catch(() => { });
            return;
        }

        this.realtimeHealth.record('presence_failures');
        const current = this.channel === channel;
        // A newer channel that already published owns the retry state.
        if (!current && this.presenceTracked) return;
        // Otherwise arm the cooldown even if the channel was replaced meanwhile:
        // the failure is what ended it, and the next join must not publish at once.
        this.consecutivePresenceFailures++;
        const delayMs = presenceRecoveryDelayMs(this.consecutivePresenceFailures);
        this.nextPresenceAttemptAt = performance.now() + delayMs;
        if (current) this.presenceTracked = false;
        console.warn(`⚠️ Presence not acknowledged (${status}) — retrying in ~${Math.round(delayMs / 60_000)} min; tool calls are unaffected`);
        captureRemote('remote_channel_presence_track_error', { attempts: 1 }).catch(() => { });
    }

    /** Presence is withheld by its cooldown right now. Monotonic, so a Date.now
     * skew correction cannot shorten or extend it. */
    private presenceInCooldown(): boolean {
        return performance.now() < this.nextPresenceAttemptAt;
    }

    /**
     * The complete `capabilities` JSONB value. The write replaces the whole
     * column, so a key left out here is dropped from the row.
     */
    private capabilitiesPayload(): Record<string, any> {
        return { app_version: VERSION };
    }

    /** Aborts one write to this device's row after DEVICE_ROW_WRITE_TIMEOUT_MS (a method, so tests can shorten it). */
    private deviceRowWriteSignal(): AbortSignal {
        return AbortSignal.timeout(DEVICE_ROW_WRITE_TIMEOUT_MS);
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
            this.realtimeHealth.newChannel();
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
                        if (!this.shuttingDown) {
                            observeTransport({ stage: 'received', payload, deviceId: this.deviceId,
                                userId: this.user?.id, transport: 'broadcast' });
                        }
                        this.onDoorbell(payload).catch((e: any) => {
                            console.error('[DEBUG] Doorbell handling failed:', e?.message);
                        });
                    }
                )
                .subscribe((status: string, err: any) => {
                    // Debug: Log all subscription status events
                    console.debug(`[DEBUG] Channel subscription status: ${status}${err ? ' (error: ' + (err?.message || err) + ')' : ''} — ${this.connState()}`);

                    if (status === 'SUBSCRIBED') {
                        this.realtimeHealth.record('join_successes');
                        // The SDK resets its rejoinTimer here even if the join dies
                        // before it is ready. Carry failure budget across such joins.
                        // reconnectAttempt is different: it counts watchdog
                        // recreations, and a join does end that particular
                        // failure mode.
                        this.consecutiveUnreadyJoins = Math.min(
                            MAX_UNREADY_JOIN_BUDGET, this.consecutiveUnreadyJoins + 1
                        );
                        const recovered = this.reconnectAttempt;
                        this.reconnectAttempt = 0; // watchdog attempts only, not recovery proof
                        const joinedAt = performance.now();
                        this.joinedAt = joinedAt;
                        this.lastHeartbeatOkAt = joinedAt; // a fresh join is proof of life too
                        console.log(`✅ Channel subscribed${recovered > 0 ? ` (recovered after ${recovered} attempt${recovered === 1 ? '' : 's'})` : ''}`);
                        // A joined channel receives doorbells; readiness only
                        // waits for the device row to say so. Presence runs
                        // beside it and never decides readiness.
                        this.readinessInFlight = null;
                        this.channelReady = false;
                        this.presenceTracked = false;
                        this.markChannelReady()
                            .catch(() => false)
                            .then((ready) => ready
                                ? resolve()
                                : reject(new ChannelUnreachableError(
                                    'channel joined but the device row could not be updated, so no command can be delivered'
                                )));
                        this.trackPresence(recovered).catch(() => { /* logged inside */ });
                    } else if (status === 'CHANNEL_ERROR') {
                        this.realtimeHealth.record('join_errors');
                        // CHANNEL_ERROR is the only status carrying a real error message.
                        console.error(`❌ Channel error: ${err?.message || 'unknown'} — ${this.connState()}`);
                        this.joinedAt = null;
                        this.channelReady = false;
                        this.presenceTracked = false;
                        this.syncReachabilityStatus();
                        // Fires on ordinary network faults too — filter on the
                        // error text to isolate an 008 misconfiguration.
                        captureRemote('remote_channel_subscription_error', { error: err?.message || 'Channel error' }).catch(() => { });
                        reject(new ChannelUnreachableError(err?.message || 'failed to subscribe to the tool call channel'));
                    } else if (status === 'TIMED_OUT') {
                        this.realtimeHealth.record('join_timeouts');
                        console.error(`⏱️ Channel subscription timed out, Reconnecting... — ${this.connState()}`);
                        this.syncReachabilityStatus();
                        captureRemote('remote_channel_subscription_timeout', { attempt: this.reconnectAttempt }).catch(() => { });
                        reject(new ChannelUnreachableError('tool call channel subscription timed out'));
                    } else if (status === 'CLOSED') {
                        this.realtimeHealth.record('join_closures');
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

        const { data: pending, error } = await this.client
            .from('mcp_remote_calls')
            .select('id,device_id')
            .eq('device_id', this.deviceId)
            .eq('status', 'pending')
            .gt('timeout_at', 'now')
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
        // so a hiccup must not cost a timeout. PostgREST interprets the
        // special timestamptz input 'now' in PostgreSQL, not on the device;
        // this atomically excludes expired rows despite client clock skew.
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
                .gt('timeout_at', 'now')
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
            // The server writes the user's rollouts into every call row; a row
            // without them (an older server) keeps what the device has.
            rolloutManager.update(row.metadata?.rollouts);
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
            .gt('timeout_at', 'now')
            .maybeSingle();
        if (error) {
            console.error(`[DEBUG] Doorbell row fetch failed for ${callId} after claim errors:`, error.message);
            await captureRemote('remote_channel_doorbell_fetch_error', { error });
            return;
        }
        if (current?.status === 'pending') {
            // No claim landed; device.ts claims it. Read-back already excludes
            // expired rows using PostgreSQL time; its own claim does likewise.
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
        this.realtimeHealth.observeSocketState(String((this.client as any)?.realtime?.connectionState?.() ?? 'unknown'));

        // Debug: Log current channel state (only if changed)
        if (!this.lastChannelState || this.lastChannelState !== state) {
            console.debug(`[DEBUG] channel state: ${state} — ${this.connState()}`);
            this.lastChannelState = state;
            if (state !== 'joined' && state !== 'joining') {
                captureRemote('remote_channel_state_health', { state, attempt: this.reconnectAttempt }).catch(() => {});
            }
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

            // Broadcast has outlived a join->error cycle with a heartbeat
            // confirmed after the join: the socket/channel path is working.
            // Stop charging this join to the reconnect budget, so a later
            // ordinary blip gets fast recovery.
            if (this.consecutiveUnreadyJoins > 0 && this.joinedAt !== null &&
                this.lastHeartbeatOkAt !== null && this.lastHeartbeatOkAt > this.joinedAt &&
                performance.now() - this.joinedAt >= STABLE_BROADCAST_RESET_MS) {
                console.debug(`[DEBUG] Broadcast channel stable for ${Math.round((performance.now() - this.joinedAt) / 1000)}s — clearing reconnect backoff budget`);
                this.consecutiveUnreadyJoins = 0;
            }

            // The channel is up, so SUBSCRIBED won't fire again: retry what the
            // join left undone, each on its own cooldown.
            if (!this.channelReady && performance.now() >= this.nextReadinessAttemptAt) {
                console.debug('[DEBUG] Channel joined but the device row is not ready — retrying');
                this.markChannelReady().catch(() => { /* logged inside */ });
            }
            if (!this.presenceTracked && this.deviceId) {
                this.trackPresence(0).catch(() => { /* logged inside */ });
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
        // Monotonic: Date.now may be patched by the clock-skew correction.
        const deadline = performance.now() + SOCKET_SETTLE_MAX_MS;
        while (realtime.isDisconnecting() && performance.now() < deadline) {
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
            // Our force-recreate fallback shares the extended sustained-failure
            // budget with the SDK. A 10s watchdog tick cannot cancel this wait
            // because isRecreatingChannel guards its whole duration.
            const backoffMs = watchdogRecreateDelayMs(
                Math.max(this.reconnectAttempt, this.consecutiveUnreadyJoins)
            );
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

            // Count only watchdog recreations that continue past SDK self-heal.
            this.realtimeHealth.record('watchdog_recreates');

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
        } finally {
            this.isRecreatingChannel = false;
        }
    }

    /**
     * Claim a call. True only when THIS update flipped the row pending ->
     * executing, which is what makes dual delivery safe across processes.
     * .eq('status','pending') makes it conditional; .select('id') makes the
     * result observable. Expiry is checked using Postgres time, not the
     * device clock. On a transient DB error it returns true (execute anyway),
     * matching prior behaviour — so device.ts's in-memory guard is what
     * actually guarantees exactly-once within a process.
     */
    async markCallExecuting(callId: string): Promise<boolean> {
        if (!this.client) throw new Error('Client not initialized');
        const { data, error } = await this.client
            .from('mcp_remote_calls')
            .update({ status: 'executing' })
            .eq('id', callId)
            .eq('status', 'pending')
            .gt('timeout_at', 'now')
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

    async updateCallResult(callId: string, status: string, result: any = null, errorMessage: string | null = null): Promise<void> {
        if (!this.client) throw new Error('Client not initialized');
        // The DB terminal-status trigger stamps completed_at using PostgreSQL
        // time. Do not send a device-generated timestamp.
        const updateData: any = { status };

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
     * joined, the join's status write landed, and the local executor answers.
     * The server needs the first two before it will dispatch, and a healthy
     * channel on a device whose executor is dead is the false-online state
     * issue #4 was opened for. Presence is not part of it. Gates the heartbeat
     * and `status`.
     */
    private isReachable(): boolean {
        return this.channel?.state === 'joined'
            && this.channelReady
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
     * Serialize the status writes, the heartbeat's included. They fire from
     * un-awaited callbacks, and inside recreateChannel() a teardown's 'offline'
     * and the fresh join's 'online' land ~100-300ms apart — unordered, 'offline'
     * can win and leave a healthy device undispatchable until the next heartbeat.
     *
     * Not the single writer: registerDevice and setOffline's subprocess write
     * status directly, so this is not total ordering.
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

    async updateHeartbeat() {
        if (!this.client) return;
        // This write asserts status:'online' too, so it MUST respect the
        // shutdown gate — otherwise a heartbeat firing (or in flight) as SIGINT
        // lands can be applied after setOffline()'s subprocess write and leave
        // an exited process marked online with a fresh last_seen, which the
        // sweep then cannot age out for its full window.
        if (this.shuttingDown) {
            console.debug('[DEBUG] Skipping heartbeat write — shutting down');
            return;
        }
        // Skip the write entirely when no transport is up. Bumping last_seen
        // on a deaf device would keep its row perpetually young, so the
        // server's staleness sweep could never age it out and correct a
        // stale 'online' — and that row is what dispatch reads. Staying
        // silent lets the sweep do its job.
        if (!this.isReachable()) {
            console.debug('[DEBUG] Skipping heartbeat write — no transport joined; letting the row age out');
            return;
        }
        // Queued, so a drop's 'offline' queued after it always lands last.
        // setOnlineStatus also refreshes last_seen and reports a failed write.
        await this.queueStatusWrite('online');
    }

    startHeartbeat(deviceId: string) {
        if (this.heartbeatDeviceId === deviceId && this.connectionCheckInterval && this.heartbeatInterval) {
            console.debug('[DEBUG] Heartbeat already active for device:', deviceId);
            return;
        }
        this.stopHeartbeat();
        this.heartbeatDeviceId = deviceId;
        console.debug('[DEBUG] Starting heartbeat for device:', deviceId);
        this.realtimeHealth.setDevice(deviceId);
        this.realtimeHealth.start();
        this.connectionCheckInterval = setInterval(() => {
            this.checkConnectionHealth();
        }, 10000);

        // Bookkeeping last_seen write. A fixed interval, so a slow write never
        // pushes the next one past the dashboard's freshness window.
        this.heartbeatInterval = setInterval(() => {
            this.updateHeartbeat().catch(() => { /* logged inside */ });
        }, HEARTBEAT_INTERVAL_MS);
        this.startTokenRefresh();
        console.debug(`[DEBUG] Heartbeat started - connectionCheck: 10s, last_seen: ${HEARTBEAT_INTERVAL_MS}ms, tokenRefresh: ${TOKEN_REFRESH_INTERVAL_MS}ms`);
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

    stopHeartbeat() {
        this.heartbeatDeviceId = null;
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
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
            .update({ status: status, last_seen: 'now' })
            .eq('id', deviceId)
            .abortSignal(this.deviceRowWriteSignal());

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

            // The node running this device, by its full path: a bare 'node' is
            // looked up in the working folder first on Windows
            const result = spawnSync(process.execPath, [
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
        this.realtimeHealth.stop();
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
        // Drain queued status writes, the heartbeat's included; the gate above
        // stops any new one.
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
