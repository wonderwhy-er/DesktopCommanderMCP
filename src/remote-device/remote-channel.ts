import { createClient, SupabaseClient, Session, UserResponse, User, RealtimeChannel } from '@supabase/supabase-js';
import { captureRemote, isTelemetryDisabledByEnv } from '../utils/capture.js';
import { configManager, isTelemetryDisabledValue } from '../config-manager.js';
import { VERSION } from '../version.js';
import { MqttDoorbellReceiver, type MqttConfig } from './mqtt-transport.js';
import { enrollMqttDevice } from './mqtt-enrollment.js';
import { captureArrival, TransportAnalytics, type ArrivalTime, type Transport, type TransportObservation } from './transport-analytics.js';

// Shared admission ceiling: onDoorbell bounds fetches; MCPDevice also bounds direct delivery.
// Overflow is dropped for the server's timeout/retry handling, never put in an unbounded queue.
export const MAX_CONCURRENT_REMOTE_CALLS = 32;

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
// Backstop for a half-open socket where 'joined' never changes and realtime-js's
// own heartbeat-close never completes. ~3x the 25s heartbeat interval.
const HEARTBEAT_STALE_TIMEOUT_MS = 75000;
// Fixed cadence for our own token refresh, independent of auth-js's internal
// ticker (disabled in initialize()) — see the clock-skew comment below for why.
const TOKEN_REFRESH_INTERVAL_MS = 45 * 60 * 1000;
// Below this, skew is noise — leave Date.now untouched. Above it, correct.
const CLOCK_SKEW_CORRECTION_THRESHOLD_MS = 5 * 60 * 1000;
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
    /** Tokens from the last setSession / TOKEN_REFRESHED, for setOffline(). */
    private lastKnownSession: { access_token: string; refresh_token: string | null } | null = null;
    /** Set by unsubscribe(): suppresses status/heartbeat writes so they can't
     * land after setOffline()'s durable write. */
    private shuttingDown = false;
    /** Auth session gone for good: stops rejoins and caps the notice at one line. */
    private sessionLost = false;
    private handlingSignedOut = false;
    /** Invalidates work admitted before sign-out or explicit session replacement. */
    private authGeneration = 0;
    /** Covers row fetch through execution/result reporting, not just MQTT packet handling. */
    private activeDoorbells = new Set<string>();
    private mqttReceiver: MqttDoorbellReceiver | null = null;
    /** Successfully prepared credentials survive the existing session recovery without reenrollment. */
    private mqttConfig: { config: MqttConfig; userId: string; deviceId: string } | null = null;
    private readonly mqttEnabled = process.env.MQTT_TRANSPORT_ENABLED === 'true';
    private readonly mqttExecutionEnabled = this.mqttEnabled && process.env.MQTT_EXECUTION_ENABLED === 'true';
    private readonly transportAnalytics: TransportAnalytics;
    private mqttReady = false;
    private broadcastReady = false;
    /** Existing non-transport fields survive whole-JSON capability replacement. */
    private capabilityBase: Record<string, any> = {};
    private capabilityWriteChain: Promise<void> = Promise.resolve();
    private capabilitiesWritten: string | null = null;


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

    /** MCPDevice supplies the same backend/profile used for authentication and device registration. */
    constructor(private readonly enrollment?: { serverUrl: string; profilePath: string }) {
        const reportingEnabled = enrollment && !isTelemetryDisabledByEnv();
        this.transportAnalytics = new TransportAnalytics(reportingEnabled ? async (observations, signal) => {
            if (isTelemetryDisabledByEnv() ||
                isTelemetryDisabledValue(await configManager.getValue('telemetryEnabled'))) return observations.length;
            if (signal.aborted) throw new Error('Transport reporting cancelled');
            const generation = this.authGeneration;
            const deviceId = this.deviceId;
            const userId = this.user?.id;
            if (!deviceId || !userId || !this.canExecuteCall(userId, deviceId, generation)) {
                throw new Error('Transport reporting session unavailable');
            }
            const backend = new URL(enrollment.serverUrl);
            const local = backend.protocol === 'http:' && process.env.MQTT_ALLOW_INSECURE_LOCAL === 'true' &&
                ['localhost', 'mcp.localhost', 'mcp.localhost.localdomain', '127.0.0.1', '[::1]'].includes(backend.hostname);
            if ((backend.protocol !== 'https:' && !local) || backend.username || backend.password) {
                throw new Error('Transport reporting requires a secure backend');
            }
            // Use the cached, refreshed device bearer token; no collector secret leaves the server.
            const token = this.lastKnownSession?.access_token;
            if (!token) throw new Error('Transport reporting session unavailable');
            const response = await fetch(new URL('/device/transport-observations', backend), {
                method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ device_id: deviceId, observations }),
            });
            if (!response.ok) throw new Error('Transport reporting failed');
            const result = await response.json() as { accepted?: number; dropped?: number };
            if (!Number.isInteger(result.accepted) || !Number.isInteger(result.dropped) ||
                result.accepted! < 0 || result.dropped! < 0 ||
                result.accepted! + result.dropped! !== observations.length) {
                throw new Error('Invalid transport reporting acknowledgement');
            }
            return result.dropped;
        } : undefined);
    }

    /** Device-side rejection/execution observers must never become execution dependencies. */
    recordTransportStage(receipt: TransportObservation | undefined, stage: string, reason?: string, generation = this.authGeneration): void {
        if (generation !== this.authGeneration || this.shuttingDown || this.sessionLost || this.handlingSignedOut) return;
        try { this.transportAnalytics.stage(receipt, stage, reason); } catch { /* telemetry only */ }
    }

    get user(): User | null { return this._user; }
    /** MCPDevice captures this admission epoch and checks it after asynchronous work. */
    get sessionGeneration(): number { return this.authGeneration; }

    /**
     * Shared gate for onDoorbell fetches and MCPDevice's execution guard. Recheck after
     * awaits: matching ids alone do not prove that the admitting session is still valid.
     */
    canExecuteCall(userId: string, deviceId: string, generation: number): boolean {
        return !!this.client && this.user?.id === userId && this.deviceId === deviceId &&
            generation === this.authGeneration && !this.handlingSignedOut &&
            !this.sessionLost && !this.shuttingDown;
    }


    initialize(url: string, key: string): void {
        // autoRefreshToken:false — we drive refresh ourselves (startTokenRefresh(),
        // see TOKEN_REFRESH_INTERVAL_MS) instead of auth-js's local-clock-driven
        // ticker. clockAwareFetch — see the clock-skew correction block above.
        this.client = createClient(url, key, {
            auth: { autoRefreshToken: false },
            global: { fetch: clockAwareFetch },
            realtime: {
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

    /** Establish the authenticated user for registration, invalidating previously admitted calls. */
    async setSession(session: AuthSession): Promise<{ error: any }> {
        // Advance before network I/O: even a failed replacement cannot revive older work.
        this.authGeneration += 1;
        this.transportAnalytics.reset();
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
        this.authGeneration += 1;
        this.transportAnalytics.reset();
        try {
            // Stop delivery before attempting restoration. Even a successful restore requires
            // a new subscription and cannot authorize claims from the previous generation.
            await this.stopMqttTransport();
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
                            if (this.deviceId) {
                                try { await this.startMqttTransport(); }
                                catch (error) {
                                    await this.stopMqttTransport();
                                    if (this.mqttExecutionEnabled) throw error;
                                    console.warn('[MQTT] Shadow reconnect unavailable; Broadcast remains selected');
                                }
                            }
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
            await this.stopMqttTransport();
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

    /** Registration reads only this user's device, including capability fields that must survive. */
    async findDevice(deviceId: string) {
        if (!this.client) throw new Error('Client not initialized');
        const { data, error } = await this.client
            .from('mcp_devices')
            .select('id, device_name, capabilities')
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

    /**
     * MCPDevice startup supplies its existing registration and handler. Keep the private
     * channel for legacy calls/results/presence, then add an opt-in MQTT subscription.
     */
    async registerDevice(capabilities: any, currentDeviceId: string | undefined, deviceName: string, onToolCall: (payload: any) => void): Promise<void> {

        console.debug('[DEBUG] RemoteChannel.registerDevice() called, deviceId:', currentDeviceId);

        let existingDevice = null;

        if (currentDeviceId && this.user) {
            console.debug('[DEBUG] Finding existing device...');
            existingDevice = await this.findDevice(currentDeviceId);
            console.debug('[DEBUG] Existing device found:', !!existingDevice);
        }

        if (existingDevice) {
            // Persisted flags describe a previous connection; prove each transport again.
            this.capabilityBase = { ...existingDevice.capabilities };
            delete this.capabilityBase.transport_broadcast_v1;
            delete this.capabilityBase.transport_mqtt_v1;
            delete this.capabilityBase.transport_mqtt_observability_v1;
            console.debug('[DEBUG] Updating device status to online');
            // The server routes from capabilities, so broadcast waits for presence and
            // MQTT waits for its QoS 1 SUBACK before either flag can be advertised.
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

            // Validate enabled MQTT configuration before opening another connection.
            const generation = this.authGeneration;
            const userId = this.user!.id;
            const assertCurrent = () => {
                if (!this.canExecuteCall(userId, existingDevice.id, generation)) {
                    throw new Error('Device session changed during MQTT startup; restart the connector');
                }
            };
            let mqttConfig: MqttConfig | null = null;
            try { mqttConfig = await this.prepareMqttConfig(assertCurrent); }
            catch (error) {
                if (this.mqttExecutionEnabled) throw error;
                console.warn('[MQTT] Shadow startup unavailable; Broadcast remains selected');
            }
            assertCurrent();
            this.mqttConfig = mqttConfig ? { config: mqttConfig, userId, deviceId: existingDevice.id } : null;
            await this.createChannel().catch((error) => {
                console.debug(`[DEBUG] Failed to create channel, will retry after socket reconnect: ${error?.message || error} — ${this.connState()}`);
            });
            assertCurrent();
            if (mqttConfig) {
                try { await this.startMqttTransport(mqttConfig); }
                catch (error) {
                    await this.stopMqttTransport();
                    if (this.mqttExecutionEnabled) throw error;
                    console.warn('[MQTT] Shadow subscription unavailable; Broadcast remains selected');
                }
            }

        } else {
            console.error(`   - ❌ Device not found: ${currentDeviceId}`);
            await captureRemote('remote_channel_register_device_error', { error: 'Device not found', deviceId: currentDeviceId });
            throw new Error(`Device not found: ${currentDeviceId}`);
        }
    }

    /** MQTT startup always enrolls or reuses its private cache; legacy startup needs no credentials. */
    private async prepareMqttConfig(assertCurrent: () => void): Promise<MqttConfig | null> {
        if (!this.mqttEnabled) {
            console.log('[MQTT] Disabled; set MQTT_TRANSPORT_ENABLED=true to enable');
            return null;
        }
        console.log('[MQTT] Enabled; preparing device credentials');
        if (!this.enrollment || !this.user || !this.deviceId) {
            throw new Error('MQTT enrollment requires the authenticated connector backend and profile');
        }
        const { data, error } = await this.getSession();
        assertCurrent();
        if (error || !data.session?.access_token) throw new Error('MQTT enrollment requires a current device session');
        return enrollMqttDevice({
            ...this.enrollment,
            userId: this.user.id,
            deviceId: this.deviceId,
            accessToken: data.session.access_token,
            assertCurrent,
        });
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
        console.error('❌ Presence track failed after retries — withdrawing broadcast capability');
        captureRemote('remote_channel_presence_track_error', { attempts }).catch(() => { });
        // Withdraw: a stale flag with no presence makes the server refuse to
        // dispatch at all. The faster heartbeat tier keeps the device's status
        // accurate for the DB-status fallback while it recovers.
        await this.setTransportCapable(false);
    }

    /**
     * Build the whole `capabilities` JSONB value for registration and writeCapabilities.
     * Each update replaces the column, so preserve unrelated keys and combine both flags.
     */
    private capabilitiesPayload(broadcastCapable: boolean): Record<string, any> {
        return {
            ...this.capabilityBase,
            app_version: VERSION,
            ...(broadcastCapable ? { transport_broadcast_v1: true } : {}),
            ...(this.mqttReady ? { transport_mqtt_v1: true, transport_mqtt_observability_v1: true } : {})
        };
    }

    /**
     * Advertise (or withdraw) the broadcast capability. Only true while genuinely
     * reachable that way — the server uses it to pick a transport, to read absent
     * presence as offline, and to choose the sweep tier, so every change must
     * re-arm the heartbeat.
     */
    private async setTransportCapable(capable: boolean): Promise<void> {
        this.broadcastReady = capable && !this.shuttingDown && !this.sessionLost;
        await this.writeCapabilities();
    }

    /**
     * Serialize MQTT and broadcast readiness writes to the device row. Connection callbacks
     * and checkConnectionHealth share this owner so older snapshots cannot win a write race.
     */
    private writeCapabilities(): Promise<void> {
        this.capabilityWriteChain = this.capabilityWriteChain.then(async () => {
            if (!this.client || !this.deviceId || !this.user) return;
            const broadcastReady = this.broadcastReady && !this.shuttingDown && !this.sessionLost;
            if (this.shuttingDown || this.sessionLost) this.mqttReady = false;
            // Read current flags when the queued write starts, not when it was enqueued.
            const capabilities = this.capabilitiesPayload(broadcastReady);
            const serialized = JSON.stringify(capabilities);
            // Only confirmed writes are cached; a failed PATCH is retried by the health loop.
            if (serialized === this.capabilitiesWritten) return;
            const { error } = await this.client
                .from('mcp_devices')
                .update({ capabilities })
                .eq('id', this.deviceId)
                .eq('user_id', this.user.id)
                // A stalled PATCH must not block every later readiness change in the chain.
                .abortSignal(AbortSignal.timeout(CAPABILITY_WRITE_TIMEOUT_MS));
            if (error) throw new Error('Transport capability write failed');
            this.capabilitiesWritten = serialized;
            this.transportCapableWritten = broadcastReady;
            // Existing heartbeat tiers still follow broadcast/presence capability in this pilot.
            this.scheduleHeartbeat();
            if (!broadcastReady && this.heartbeatDeviceId) {
                void this.updateHeartbeat(this.heartbeatDeviceId).catch(() => {});
            }
        }).catch(() => {
            // Recover the chain so one failed write does not reject all future updates.
            console.error('[DEBUG] Transport capability update failed');
        });
        return this.capabilityWriteChain;
    }

    /** Registration or session recovery starts one receiver bound to the authenticated device. */
    private async startMqttTransport(config?: MqttConfig | null): Promise<void> {
        if (!this.mqttEnabled) return;
        if (config === undefined) {
            if (this.mqttConfig) {
                // Session restoration may reuse credentials only for the same authenticated identity.
                if (this.mqttConfig.userId !== this.user?.id || this.mqttConfig.deviceId !== this.deviceId) {
                    throw new Error('MQTT credentials belong to a different device session; restart the connector');
                }
                config = this.mqttConfig.config;
            } else if (this.mqttEnabled) {
                throw new Error('MQTT enrollment has not completed; restart the connector');
            } else {
                config = null;
            }
        }
        if (!config || this.shuttingDown || this.sessionLost) return;
        if (!this.user || !this.deviceId || this.mqttReceiver) {
            throw new Error('MQTT requires one authenticated registered device');
        }
        this.mqttReceiver = new MqttDoorbellReceiver(
            config, this.user.id, this.deviceId,
            (payload, arrival) => this.onDoorbell(payload, 'mqtt', arrival),
            async (ready) => {
                // SUBACK/close report readiness; shutdown/session loss always wins a late callback.
                this.mqttReady = ready && !this.shuttingDown && !this.sessionLost;
                await this.writeCapabilities();
            },
            () => this.transportAnalytics.rejectMalformed(),
        );
        await this.mqttReceiver.start();
    }

    /** Sign-out/shutdown withdraws readiness and detaches the receiver before awaiting its stop. */
    private async stopMqttTransport(): Promise<void> {
        this.mqttReady = false;
        const receiver = this.mqttReceiver;
        this.mqttReceiver = null;
        if (receiver) await receiver.stop();
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
                        const arrival = captureArrival();
                        this.onDoorbell(payload, 'broadcast', arrival).catch(() => {
                            console.error('[BROADCAST] Doorbell handling failed', { call_id: payload?.call_id });
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

    /** Await MCPDevice's registered handler so onDoorbell holds its slot through result reporting. */
    private async dispatchToolCall(payload: any): Promise<void> {
        try {
            await this.onToolCall?.(payload);
        } catch (e: any) {
            console.error('[DEBUG] Tool call handler failed', { call_id: payload?.new?.id });
        }
    }

    /**
     * Shared MQTT/private-broadcast entry point. Fetch the durable row by id and
     * authenticated user/device, then adapt it to MCPDevice's existing `{ new: row }`
     * handler shape. Notifications never supply tool arguments or execution authority.
     */
    private async onDoorbell(payload: any, transport: Transport = 'broadcast', arrival = captureArrival()): Promise<void> {
        const callId = payload?.call_id;
        if (!this.user || !this.deviceId || this.shuttingDown || this.sessionLost || this.handlingSignedOut) return;
        if (typeof callId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(callId) ||
            payload.device_id !== this.deviceId || (payload.user_id && payload.user_id !== this.user.id)) {
            this.transportAnalytics.rejectMalformed();
            return;
        }
        const generation = this.authGeneration;
        let receipt: TransportObservation | undefined;
        try {
            receipt = this.transportAnalytics.receipt(callId, transport, arrival,
                transport === 'mqtt' ? payload.notification_id : undefined,
                transport === 'mqtt' ? payload.attempt_number : undefined);
        } catch { /* analytics cannot prevent admission */ }
        const rejected = (reason: string) => this.recordTransportStage(receipt, 'handling_rejected', reason, generation);
        // Receipt precedes expiry and source selection, including observation-only messages.
        if (payload.expires_at && Date.parse(payload.expires_at) <= Date.now()) { rejected('expired'); return; }
        const selected: Transport = this.mqttExecutionEnabled ? 'mqtt' : 'broadcast';
        if (transport !== selected) {
            this.recordTransportStage(receipt, 'execution_skipped', 'observation_only', generation);
            return;
        }
        if (this.activeDoorbells.has(callId)) { rejected('duplicate'); return; }
        if (this.activeDoorbells.size >= MAX_CONCURRENT_REMOTE_CALLS) { rejected('concurrency_limit'); return; }
        this.activeDoorbells.add(callId);
        // Capture identity before any wait; sign-out can restore the same ids.
        const userId = this.user.id;
        const deviceId = this.deviceId;
        try {
            console.debug('[DEBUG] Selected doorbell received for call:', callId);

            if (!this.client) { rejected('unavailable'); return; }

            // Retry transient REST errors on a fixed budget. Each request is abortable,
            // and every retry rechecks admission so session loss/expiry cannot revive work.
            let row: any = null;
            let lastError: any = null;
            for (const delayMs of [0, 500, 1500]) {
                if (delayMs > 0) await this.sleep(delayMs);
                if (!this.canExecuteCall(userId, deviceId, generation)) { rejected('unavailable'); return; }
                if (payload.expires_at && Date.parse(payload.expires_at) <= Date.now()) { rejected('expired'); return; }
                const { data, error } = await this.client
                    .from('mcp_remote_calls')
                    .select('*')
                    .eq('id', callId)
                    .eq('user_id', this.user.id)
                    .eq('device_id', this.deviceId)
                    .abortSignal(AbortSignal.timeout(CAPABILITY_WRITE_TIMEOUT_MS))
                    .maybeSingle();
                if (!error) {
                    row = data;
                    lastError = null;
                    break;
                }
                lastError = error;
                console.debug('[DEBUG] Doorbell row fetch attempt failed; retrying', { call_id: callId });
            }

            if (lastError) {
                console.error('[DEBUG] Doorbell row fetch failed after retries', { call_id: callId });
                rejected('unavailable');
                await captureRemote('remote_channel_doorbell_fetch_error', { call_id: callId });
                return;
            }
            if (!row) {
                // Already claimed and deleted, or cleanup raced delivery. Not
                // retried: the row is always inserted before the doorbell is sent.
                rejected('invalid_row');
                await captureRemote('remote_channel_doorbell_row_missing', { call_id: callId });
                return;
            }
            // The fetched row must agree with admission and the MQTT deadline. This is
            // validation, not a claim: markCallExecuting arbitrates competing processes.
            const deadline = row.timeout_at ?? row.metadata?.expires_at;
            if (!this.canExecuteCall(userId, deviceId, generation) ||
                row.user_id !== userId || row.device_id !== deviceId ||
                (payload.expires_at && Date.parse(payload.expires_at) !== Date.parse(deadline)) ||
                (deadline && (!Number.isFinite(Date.parse(deadline)) || Date.parse(deadline) <= Date.now()))) { rejected('invalid_row'); return; }
            // Skip a redundant claim for known terminal/executing rows. A concurrent claim
            // after this read is still handled by the conditional database update.
            if (row.status !== 'pending') {
                rejected('claim_lost');
                console.debug('[DEBUG] Doorbell call already claimed:', callId);
                return;
            }

            await this.dispatchToolCall({ new: row, transportObservation: receipt, transportGeneration: generation });
        } catch {
            rejected('unavailable');
            console.error('[DEBUG] Doorbell handling failed', { call_id: callId });
        } finally {
            // Keep the slot until the handler settles, then release on success or any error.
            this.activeDoorbells.delete(callId);
        }
    }

    /**
     * MCPDevice calls this after updateCallResult. Results still use Supabase Broadcast
     * in the MQTT pilot; send failures are contained and the server's recovery poll checks
     * the durable row. The notification itself does not carry or prove a stored result.
     */
    async notifyResult(callId: string): Promise<void> {
        if (!this.channel || this.channel.state !== 'joined') {
            console.debug('[DEBUG] Result doorbell skipped — channel not joined (recovery poll covers)', { call_id: callId });
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
                captureRemote('remote_channel_result_doorbell_send_failed', { call_id: callId, result }).catch(() => { });
            }
        } catch (error: any) {
            console.debug('[DEBUG] Result doorbell send failed (recovery poll covers)', { call_id: callId });
            captureRemote('remote_channel_result_doorbell_send_failed', { call_id: callId }).catch(() => { });
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
     * Existing health timer retries capability persistence and repairs the private channel.
     * MQTT.js owns its separate socket reconnects; this does not create another MQTT client.
     */
    private checkConnectionHealth(): void {
        if (this.sessionLost || this.shuttingDown) return;
        // Retry a failed capability PATCH on the existing health cadence.
        void this.writeCapabilities();
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
     * MCPDevice's cross-process arbitration: update only this authenticated device's pending,
     * unexpired row and return true only when the database reports a match. Ambiguous/errors
     * fail closed; the caller also rechecks session/deadline after this await before execution.
     */
    async markCallExecuting(callId: string, deadline?: string): Promise<boolean> {
        if (!this.client || !this.user || !this.deviceId ||
            !this.canExecuteCall(this.user.id, this.deviceId, this.authGeneration)) return false;
        if (deadline && (!Number.isFinite(Date.parse(deadline)) || Date.parse(deadline) <= Date.now())) return false;
        try {
            let query = this.client
                .from('mcp_remote_calls')
                .update({ status: 'executing' })
                .eq('id', callId)
                .eq('user_id', this.user.id)
                .eq('device_id', this.deviceId)
                .eq('status', 'pending');
            // Check the stored deadline in the conditional UPDATE, not only the fetched snapshot.
            if (deadline) query = query.gt('timeout_at', new Date(Date.now()).toISOString());
            const { data, error } = await query.select('id')
                .abortSignal(AbortSignal.timeout(CAPABILITY_WRITE_TIMEOUT_MS));
            if (error) {
                console.error('[DEBUG] Failed to claim call; execution skipped', { call_id: callId });
                void captureRemote('remote_channel_mark_call_executing_error', { call_id: callId }).catch(() => {});
                return false;
            }
            return !!data && data.length > 0;
        } catch {
            console.error('[DEBUG] Failed to claim call; execution skipped', { call_id: callId });
            return false;
        }
    }

    /**
     * MCPDevice persists completion/failure here before notifyResult. Bound every write,
     * including the recursive text-only fallback, so stalled I/O cannot occupy all 32 slots.
     */
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
            .eq('id', callId)
            .abortSignal(AbortSignal.timeout(CAPABILITY_WRITE_TIMEOUT_MS));

        if (error) {
            console.error('[DEBUG] Failed to update call result', { call_id: callId });
            await captureRemote('remote_channel_update_call_result_error', { call_id: callId });

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

    /** Pilot reachability still requires the private result/presence channel, even with MQTT input. */
    private isReachable(): boolean {
        return this.channel?.state === 'joined';
    }

    /**
     * Set the status used by server dispatch from the same reachability predicate as
     * the heartbeat. MQTT input capability alone does not remove this pilot's dependency
     * on the private channel for results and presence.
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

    /** MCPDevice shutdown closes both inputs before its final durable offline update. */
    async unsubscribe() {
        // setOffline()'s durable write is the final word on `status` from here,
        // so stop the heartbeat and the channel callbacks from racing it. The
        // races that matter: a heartbeat tick firing as the signal arrives, and
        // SIGINT during recreateChannel()'s backoff, where the later join's
        // SUBSCRIBED would queue 'online' after the durable write.
        this.shuttingDown = true;
        this.transportAnalytics.stop();
        // Socket stop is immediate; do not let capability persistence consume the exit budget.
        await Promise.race([this.stopMqttTransport(), this.sleep(250)]);
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
