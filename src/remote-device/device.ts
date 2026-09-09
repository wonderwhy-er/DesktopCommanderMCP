#!/usr/bin/env node

import { RemoteChannel, type AuthSession } from './remote-channel.js';
import { DeviceAuthenticator } from './device-authenticator.js';
import { DesktopCommanderIntegration } from './desktop-commander-integration.js';
import { fileURLToPath } from 'url';
import os from 'os';
import fs from 'fs/promises';
import path from 'path';
import { captureRemote } from '../utils/capture.js';

export interface MCPDeviceOptions {
    persistSession?: boolean;
}

/**
 * How many recently-handled call ids to remember for duplicate-delivery
 * suppression. The two transports deliver a call within MILLISECONDS of each
 * other, so this only has to outlive that window — 100 ids is several minutes
 * of even the heaviest agent traffic, and costs ~10 KB on the user's machine
 * (the device process, not the shared server).
 */
const SEEN_CALL_IDS_MAX = 100;
const PERSISTED_DEVICE_LOOKUP_ATTEMPTS = 3;
const PERSISTED_DEVICE_LOOKUP_RETRY_MS = 250;

export function getRemoteDeviceConfigPath() {
    return path.join(os.homedir(), '.desktop-commander-device', 'device.json');
}

export class MCPDevice {
    private baseServerUrl: string;
    private remoteChannel: RemoteChannel;
    private deviceId?: string;
    private isShuttingDown: boolean;
    private configPath: string;
    private persistSession: boolean;
    private desktop: DesktopCommanderIntegration;
    private configWriteChain: Promise<void> = Promise.resolve();
    private configWriteSequence = 0;
    private sessionPersistenceEnabled = false;
    /** Call ids already handled by THIS process (insertion-ordered, bounded). */
    private seenCallIds: Set<string> = new Set();

    constructor(options: MCPDeviceOptions = {}) {
        this.baseServerUrl = process.env.MCP_SERVER_URL || 'https://mcp.desktopcommander.app';
        this.remoteChannel = new RemoteChannel();
        this.deviceId = undefined;
        this.isShuttingDown = false;
        this.configPath = getRemoteDeviceConfigPath();
        // Default ON. Off meant a full re-authorization on every start, and each
        // one mints a fresh GoTrue session that nothing ever revokes; the orphaned
        // refresh-token families get replayed, trip GoTrue's reuse detection, and
        // take the whole family down including the token a healthy connector holds.
        this.persistSession = options.persistSession ?? true;

        // Initialize desktop integration
        this.desktop = new DesktopCommanderIntegration();

        // Graceful shutdown handlers (only set once)
        this.setupShutdownHandlers();
    }

    private enableSessionPersistence(): void {
        if (!this.persistSession || this.sessionPersistenceEnabled) return;
        this.sessionPersistenceEnabled = true;
        this.remoteChannel.onSessionRotated((session) => this.queuePersistedSession(session));
    }

    private disableSessionPersistence(): void {
        if (!this.sessionPersistenceEnabled) return;
        this.remoteChannel.onSessionRotated(null);
        this.sessionPersistenceEnabled = false;
    }

    private setupShutdownHandlers() {
        const handleShutdown = async (signal: string) => {
            if (this.isShuttingDown) {
                console.log(`\n${signal} received, but already shutting down...`);
                // Force exit if we get multiple signals
                process.exit(1);
                return;
            }

            console.log(`\n${signal} received, initiating graceful shutdown...`);

            // Force exit after 10 seconds if graceful shutdown hangs
            const forceExit = setTimeout(() => {
                console.error('\n⚠️ Graceful shutdown timed out, forcing exit...');
                process.exit(1);
            }, 10000);

            try {
                await this.shutdown();
                clearTimeout(forceExit);
                process.exit(0);
            } catch (error) {
                console.error('Error during shutdown:', error);
                await captureRemote('remote_device_shutdown_handler_error', { error });
                process.exit(1);
            }
        };

        // Remove any existing SIGINT/SIGTERM listeners to prevent default behavior
        // process.removeAllListeners('SIGINT');
        // process.removeAllListeners('SIGTERM');

        // Add our custom handlers
        process.on('SIGINT', () => {
            handleShutdown('SIGINT').catch((error) => {
                console.error('Fatal error during shutdown:', error);
                captureRemote('remote_device_shutdown_handler_error', { error, signal: 'SIGINT' }).catch(() => { });
                process.exit(1);
            });
        });

        process.on('SIGTERM', () => {
            handleShutdown('SIGTERM').catch((error) => {
                console.error('Fatal error during shutdown:', error);
                captureRemote('remote_device_shutdown_handler_error', { error, signal: 'SIGTERM' }).catch(() => { });
                process.exit(1);
            });
        });
    }

    async start() {
        try {
            console.log('🚀 Starting MCP Device...');
            if (process.env.DEBUG_MODE === 'true') {
                console.log(`  - 🐞 DEBUG_MODE`);
            }


            // Initialize desktop integration
            await this.desktop.initialize();
            this.desktop.onDisconnect((reason) => void this.handleLocalMcpLoss(reason));

            console.log(`⏳ Connecting to Remote MCP ${this.baseServerUrl}`);
            const { supabaseUrl, anonKey } = await this.fetchSupabaseConfig();
            console.log(`   - 🔌 Connected to Remote MCP`);

            // Initialize Remote Channel
            this.remoteChannel.initialize(supabaseUrl, anonKey);

            // Load persisted configuration (deviceId, session)
            let session = await this.loadPersistedConfig();

            // 2. Set Session or Authenticate
            if (session) {
                const { error } = await this.remoteChannel.setSession(session);

                if (error) {
                    console.log('   - ⚠️ Persisted session invalid:', error.message);
                    session = null;
                } else {
                    console.log('   - ✅ Session restored');
                    console.log('   - ℹ️  To log out locally: npx @wonderwhy-er/desktop-commander@latest remote --logout');

                    // Revoking a device removes its server-side mcp_devices row, but the
                    // local config can still hold a valid user session + the now-deleted
                    // device ID. Do not silently recreate the revoked device with that
                    // old session: revocation must require a fresh browser authorization.
                    if (this.deviceId) {
                        const persistedDevice = await this.findPersistedDeviceWithRetry(this.deviceId);
                        if (!persistedDevice) {
                            console.log(`   - ⚠️ Persisted device ${this.deviceId} was revoked or removed`);
                            await this.clearPersistedConfig();
                            this.deviceId = undefined;
                            session = null;
                        }
                    }
                }
            }

            if (!session) {
                console.log('\n🔐 Authenticating with Remote MCP server...');
                const authenticator = new DeviceAuthenticator(this.baseServerUrl);
                session = await authenticator.authenticate(this.deviceId);
                if (session.device_id) {
                    if (!this.deviceId) {
                        await captureRemote('remote_device_auth_success', {
                            "device": "assigned"
                        });
                        console.log(`   - ✅ Device ID assigned: ${session.device_id}`);
                    } else if (this.deviceId !== session.device_id) {
                        await captureRemote('remote_device_auth_success', {
                            "device": "changed"
                        });
                        console.log(`   - ⚠️ Device ID changed: ${this.deviceId} → ${session.device_id}`);
                    } else {
                        await captureRemote('remote_device_auth_success', {
                            "device": "authenticated"
                        });
                        console.log(`   - ✅ Device ID authenticated: ${session.device_id}`);
                    }
                    this.deviceId = session.device_id;
                }
                // Set session in Remote Channel
                const { error } = await this.remoteChannel.setSession(session);
                if (error) throw error;
            }


            // Save only after a restored device has passed the #684 revoked-device
            // lookup. Then arm rotation persistence so an internal startup refresh
            // cannot recreate a config we just cleared for a revoked device.
            await this.removeStalePersistedConfigTemps().catch((error: any) => {
                console.debug('[DEBUG] Stale config temp cleanup failed:', error?.message ?? error);
            });
            await this.savePersistedConfig();
            this.enableSessionPersistence();

            const deviceName = os.hostname();

            // Register as device
            await this.remoteChannel.registerDevice(
                await this.desktop.listClientTools(),
                this.deviceId,
                deviceName,
                (payload: any) => this.handleNewToolCall(payload)
            );

            console.log('✅ Device ready:');
            console.log(`   - User:         ${this.remoteChannel.user!.email}`);
            console.log(`   - Device ID:    ${this.deviceId}`);
            console.log(`   - Device Name:  ${deviceName}`);

            // Keep process alive
            this.remoteChannel.startHeartbeat(this.deviceId!);

        } catch (error: any) {
            console.error(' - ❌ Device startup failed:', error.message);
            if (error.stack && process.env.DEBUG_MODE === 'true') {
                console.error('Stack trace:', error.stack);
            }
            await captureRemote('remote_device_startup_failed', { error });
            await this.shutdown();
            process.exit(1);
        }
    }



    private async findPersistedDeviceWithRetry(deviceId: string) {
        let lastError: any;
        for (let attempt = 1; attempt <= PERSISTED_DEVICE_LOOKUP_ATTEMPTS; attempt++) {
            try {
                return await this.remoteChannel.findDevice(deviceId);
            } catch (error: any) {
                lastError = error;
                if (attempt === PERSISTED_DEVICE_LOOKUP_ATTEMPTS) break;
                console.warn(`   - ⚠️ Device lookup failed (${attempt}/${PERSISTED_DEVICE_LOOKUP_ATTEMPTS}); retrying...`);
                await new Promise((resolve) => setTimeout(resolve, PERSISTED_DEVICE_LOOKUP_RETRY_MS * attempt));
            }
        }
        throw lastError;
    }

    async loadPersistedConfig() {
        try {
            console.debug('[DEBUG] Loading persisted config from:', this.configPath);
            const data = await fs.readFile(this.configPath, 'utf8');
            const config = JSON.parse(data);

            this.deviceId = config?.deviceId;
            console.debug('[DEBUG] Loaded device ID:', this.deviceId);

            if (config.session && this.persistSession) {
                console.log('💾 Found persisted session for device ' + this.deviceId);
                console.debug('[DEBUG] Session found in config, returning session');
                return config.session;
            }

            // A previously saved session must not be reused on an opted-out run:
            // it would skip the re-authorization the flag promises, and the save
            // at the end of start() then discards a possibly-rotated refresh
            // token — orphaning one more live server-side session.
            if (config.session) {
                console.debug('[DEBUG] Ignoring persisted session (--no-persist-session)');
            } else {
                console.debug('[DEBUG] No session in config');
            }
            return null;
        } catch (error: any) {

            if (error.code !== 'ENOENT') {
                console.warn('⚠️ Failed to load config:', error.message);
                await captureRemote('remote_device_config_load_error', { error });
            } else {
                console.debug('[DEBUG] Config file does not exist (ENOENT)');
            }
            return null;
        } finally {
            // No need to ensure device ID here
        }
    }

    private async removeStalePersistedConfigTemps(): Promise<void> {
        const dir = path.dirname(this.configPath);
        const prefix = `${path.basename(this.configPath)}.tmp-`;
        let names: string[];
        try {
            names = await fs.readdir(dir);
        } catch (error: any) {
            if (error?.code === 'ENOENT') return;
            throw error;
        }
        for (const name of names) {
            if (!name.startsWith(prefix)) continue;
            const pid = Number(name.slice(prefix.length).split('-')[0]);
            let alive = pid === process.pid;
            if (!alive && Number.isInteger(pid) && pid > 0) {
                try { process.kill(pid, 0); alive = true; }
                catch (error: any) { alive = error?.code === 'EPERM'; }
            }
            if (alive) continue;
            await fs.rm(path.join(dir, name), { force: true }).catch(() => { });
        }
    }

    async clearPersistedConfig() {
        try {
            await fs.rm(this.configPath, { force: true });
            await this.removeStalePersistedConfigTemps();
            console.debug('[DEBUG] Cleared stale persisted config:', this.configPath);
        } catch (error: any) {
            console.warn('⚠️ Failed to clear stale config:', error.message);
            await captureRemote('remote_device_config_clear_error', { error });
        }
    }

    private async writePersistedConfigSnapshot(config: {
        deviceId?: string;
        session: { access_token: string; refresh_token: string } | null;
    }): Promise<void> {
        const configDir = path.dirname(this.configPath);
        const tempPath = `${this.configPath}.tmp-${process.pid}-${++this.configWriteSequence}`;
        console.debug('[DEBUG] Creating config directory:', configDir);
        await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
        try {
            await fs.writeFile(tempPath, JSON.stringify(config, null, 2), { mode: 0o600 });
            const deadline = performance.now() + 2000;
            let delayMs = 10;
            while (true) {
                try {
                    await fs.rename(tempPath, this.configPath);
                    break;
                } catch (error: any) {
                    const retryable = error?.code === 'EPERM' || error?.code === 'EACCES' || error?.code === 'EBUSY';
                    const remaining = deadline - performance.now();
                    if (!retryable || remaining <= 0) throw error;
                    await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, remaining)));
                    delayMs = Math.min(delayMs * 2, 100);
                }
            }
            console.debug('[DEBUG] Config saved atomically to:', this.configPath);
        } finally {
            await fs.rm(tempPath, { force: true }).catch(() => { });
        }
    }

    private enqueueConfigWrite(operation: () => Promise<void>): Promise<void> {
        const write = this.configWriteChain.then(operation);
        this.configWriteChain = write.catch(() => { });
        return write;
    }

    private queuePersistedConfig(config: {
        deviceId?: string;
        session: { access_token: string; refresh_token: string } | null;
    }): Promise<void> {
        return this.enqueueConfigWrite(() => this.writePersistedConfigSnapshot(config));
    }

    private queuePersistedIdentityOnly(): Promise<void> {
        if (!this.deviceId) return Promise.resolve();
        return this.enqueueConfigWrite(async () => {
            try {
                const existing = JSON.parse(await fs.readFile(this.configPath, 'utf8'));
                if (existing?.session?.access_token && existing?.session?.refresh_token) return;
            } catch (error: any) {
                if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
            }
            await this.writePersistedConfigSnapshot({ deviceId: this.deviceId, session: null });
        });
    }

    private queuePersistedSession(session: AuthSession): Promise<void> {
        if (!this.persistSession) return Promise.resolve();
        if (!this.deviceId) {
            console.warn('⚠️ Refusing to persist refreshed credentials without a device ID');
            void captureRemote('remote_device_config_incomplete_session_skipped', {
                hasDeviceId: false,
                hasAccessToken: !!session.access_token,
                hasRefreshToken: !!session.refresh_token,
            }).catch(() => { });
            return Promise.resolve();
        }
        if (!session.access_token || !session.refresh_token) {
            console.warn('⚠️ Refusing to overwrite persisted credentials with an incomplete refreshed session');
            void captureRemote('remote_device_config_incomplete_session_skipped', {
                hasDeviceId: true,
                hasAccessToken: !!session.access_token,
                hasRefreshToken: !!session.refresh_token,
            }).catch(() => { });
            return Promise.resolve();
        }
        return this.queuePersistedConfig({
            deviceId: this.deviceId,
            session: {
                access_token: session.access_token,
                refresh_token: session.refresh_token,
            },
        });
    }
    private async flushPersistedConfigWrites(timeoutMs = 2500): Promise<boolean> {
        const deadline = performance.now() + timeoutMs;
        while (true) {
            const observed = this.configWriteChain;
            const remaining = deadline - performance.now();
            if (remaining <= 0) {
                console.warn('⚠️ Timed out while draining persisted-session writes');
                return false;
            }
            let timer: NodeJS.Timeout | undefined;
            const timedOut = await Promise.race([
                observed.then(() => false),
                new Promise<boolean>((resolve) => {
                    timer = setTimeout(() => resolve(true), remaining);
                }),
            ]);
            if (timer) clearTimeout(timer);
            if (timedOut) {
                console.warn('⚠️ Timed out while draining persisted-session writes');
                return false;
            }
            if (observed === this.configWriteChain) return true;
        }
    }
    async savePersistedConfig() {
        try {
            console.debug('[DEBUG] Saving persisted config, persistSession:', this.persistSession);
            const currentSessionStore = await this.remoteChannel.getSession();
            const session = currentSessionStore.data.session;
            if (!this.persistSession) {
                await this.queuePersistedConfig({ deviceId: this.deviceId, session: null });
                return;
            }
            if (!session?.access_token || !session.refresh_token) {
                console.warn('⚠️ Refusing to overwrite persisted credentials with an incomplete current session');
                void captureRemote('remote_device_config_incomplete_session_skipped', {
                    hasDeviceId: !!this.deviceId,
                    hasAccessToken: !!session?.access_token,
                    hasRefreshToken: !!session?.refresh_token,
                }).catch(() => { });
                await this.queuePersistedIdentityOnly();
                return;
            }
            await this.queuePersistedSession({
                access_token: session.access_token,
                refresh_token: session.refresh_token,
            });
        } catch (error: any) {
            console.error(' - ❌ Failed to persist current session:', error.message);
            void captureRemote('remote_device_config_save_error', { error }).catch(() => { });
        }
    }

    async fetchSupabaseConfig() {
        // No auth header needed for this public endpoint
        console.debug('[DEBUG] Fetching Supabase config from:', `${this.baseServerUrl}/api/mcp-info`);
        const response = await fetch(`${this.baseServerUrl}/api/mcp-info`);

        if (!response.ok) {
            console.debug('[DEBUG] Supabase config fetch failed, status:', response.status, response.statusText);
            throw new Error(`Failed to fetch Supabase config: ${response.statusText}`);
        }

        const config = await response.json();
        console.debug('[DEBUG] Supabase config received, URL:', config.supabaseUrl?.substring(0, 30) + '...');
        return {
            supabaseUrl: config.supabaseUrl,
            anonKey: config.supabasePublishableKey
        };
    }

    // Methods moved to RemoteChannel

    /**
     * The local Desktop Commander child died. A healthy remote channel says
     * nothing about the local half being alive, so without this the device kept
     * reporting itself online and every routed tool call came back "Not
     * connected" until someone restarted the process by hand.
     */
    private async handleLocalMcpLoss(reason: string) {
        if (this.deviceId) {
            await this.remoteChannel.setOnlineStatus(this.deviceId, 'offline')
                .catch((e: any) => console.error('Failed to mark device offline:', e.message));
        }

        // Recover proactively rather than waiting for the next tool call to
        // trigger the lazy restart: we just went offline, so no further calls
        // would be routed here and that wait would never end.
        try {
            await this.desktop.ensureReady();
            if (this.deviceId) {
                await this.remoteChannel.setOnlineStatus(this.deviceId, 'online');
            }
            console.log('♻️  Local Desktop Commander MCP restarted; device is online again');
        } catch (error: any) {
            console.error(`❌ Could not restart local Desktop Commander MCP: ${error.message}`);
            await captureRemote('remote_device_local_mcp_restart_failed', { error, reason });
        }
    }

    /** Record a handled call id, evicting the oldest once the cap is reached. */
    private rememberCallId(callId: string) {
        this.seenCallIds.add(callId);
        if (this.seenCallIds.size > SEEN_CALL_IDS_MAX) {
            // Sets iterate in insertion order — drop the oldest entry.
            const oldest = this.seenCallIds.values().next().value;
            if (oldest !== undefined) this.seenCallIds.delete(oldest);
        }
    }

    async handleNewToolCall(payload: any) {
        const toolCall = payload.new;
        // Expect toolCall to include a device_id field used to route calls to this device instance.
        const { id: call_id, tool_name, tool_args, device_id, metadata = {} } = toolCall;

        console.debug('[DEBUG] Tool call received, device_id:', device_id, 'this.deviceId:', this.deviceId);

        // Only process jobs for this device
        if (device_id && device_id !== this.deviceId) {
            console.debug('[DEBUG] Ignoring tool call for different device');
            return;
        }

        console.log(`🔧 Received tool call ${call_id}: ${tool_name} ${JSON.stringify(tool_args)} metadata: ${JSON.stringify(metadata)}`);

        // LOCAL claim first — this is the authoritative guard against executing
        // a call twice. During the transition both transports deliver every call
        // to THIS SAME PROCESS, so an in-memory check is sufficient and, unlike
        // the DB claim below, cannot fail open: a transient REST error made
        // markCallExecuting return true for both deliveries, which could run a
        // side-effecting command twice (found in review, 2026-07-24).
        if (this.seenCallIds.has(call_id)) {
            console.debug('[DEBUG] Duplicate delivery for call already handled here, skipping:', call_id);
            return;
        }
        this.rememberCallId(call_id);

        try {
            // DB claim second — keeps the row state machine honest, gives
            // cross-restart/cross-process protection, and is observable. It may
            // fail open (returns true on a transient write error); the local
            // guard above is what makes execution exactly-once.
            const claimed = await this.remoteChannel.markCallExecuting(call_id);
            if (!claimed) {
                // markCallExecuting already logged the duplicate-delivery skip.
                return;
            }

            let result;

            // Handle 'ping' tool specially
            if (tool_name === 'ping') {
                result = {
                    content: [{
                        type: 'text',
                        text: `pong ${new Date().toISOString()}`
                    }]
                };
            } else if (tool_name === 'shutdown') {
                result = {
                    content: [{
                        type: 'text',
                        text: `Shutdown initialized at ${new Date().toISOString()}`
                    }]
                };

                // Trigger shutdown after sending response
                setTimeout(async () => {
                    console.log('🛑 Remote shutdown requested. Exiting...');
                    await this.shutdown();
                    process.exit(0);
                }, 1000);
            } else {
                // Execute other tools using desktop integration
                result = await this.desktop.callClientTool(tool_name, tool_args, metadata);
            }

            console.log(`✅ Tool call ${tool_name} completed:\r\n ${JSON.stringify(result)}`);

            // Update database with result, THEN ring the doorbell — the server
            // fetches the row by id on the doorbell, so the write must land first.
            await this.remoteChannel.updateCallResult(call_id, 'completed', result);
            await this.remoteChannel.notifyResult(call_id);

        } catch (error: any) {
            console.error(`❌ Tool call ${tool_name} failed:`, error.message);
            // The failure path must not fail: this method's promise is discarded
            // at every call site, so a throw here becomes an unhandled rejection
            // and takes the device process down.
            try {
                await captureRemote('remote_device_tool_call_failed', { error, tool_name });
                await this.remoteChannel.updateCallResult(call_id, 'failed', null, error.message);
                await this.remoteChannel.notifyResult(call_id);
            } catch (reportError: any) {
                console.error(`❌ Could not report failure for ${call_id}:`, reportError?.message);
            }
        }
    }

    async shutdown() {
        if (this.isShuttingDown) {
            console.debug('[DEBUG] Shutdown already in progress, returning');
            return;
        }

        this.isShuttingDown = true;
        console.log('\n🛑 Shutting down device...');
        console.debug('[DEBUG] Shutdown initiated for device:', this.deviceId);

        try {
            // Stop future heartbeat/token-refresh ticks first. Keep the persistence
            // observer armed while a refresh already in flight is given a bounded
            // chance to finish and enqueue its rotated token snapshot.
            console.log('  → Stopping heartbeat...');
            console.debug('[DEBUG] Calling stopHeartbeat()');
            this.remoteChannel.stopHeartbeat();
            console.log('  ✓ Heartbeat stopped');

            console.log('  → Waiting for in-flight token refresh...');
            const refreshSettled = await this.remoteChannel.waitForTokenRefresh(1500);
            console.log(refreshSettled
                ? '  ✓ No token refresh pending at shutdown'
                : '  ⚠️ Token refresh still in flight after shutdown bound');
            if (!refreshSettled) {
                void captureRemote('remote_device_token_refresh_shutdown_timeout', {}).catch(() => { });
            }

            console.log('  → Flushing persisted session...');
            const persistedDrained = await this.flushPersistedConfigWrites();
            this.disableSessionPersistence();
            console.log(persistedDrained
                ? '  ✓ Persisted-session writes drained'
                : '  ⚠️ Persisted-session writes did not drain in time');
            if (!persistedDrained) {
                void captureRemote('remote_device_config_drain_timeout', {}).catch(() => { });
            }

            // Unsubscribe from channel
            console.log('  → Unsubscribing from channel...');
            console.debug('[DEBUG] Calling channel.unsubscribe()');
            await this.remoteChannel.unsubscribe();

            // Mark device offline
            console.log('  → Marking device offline...');
            console.debug('[DEBUG] Calling setOffline() with deviceId:', this.deviceId);
            await this.remoteChannel.setOffline(this.deviceId);

            // Shutdown desktop integration
            console.log('  → Shutting down desktop integration...');
            console.debug('[DEBUG] Calling desktop.shutdown()');
            await this.desktop.shutdown();
            console.log('  ✓ Desktop integration shut down');

            console.log('✓ Device shutdown complete');
            console.debug('[DEBUG] Shutdown sequence completed successfully');
        } catch (error: any) {
            console.error('Shutdown error:', error.message);
            console.debug('[DEBUG] Shutdown error stack:', error.stack);
            await captureRemote('remote_device_shutdown_error', { error });
        }
    }
}

// Start device if called directly or as a bin command
// When installed globally, npm creates a wrapper, so we need to check multiple conditions
const isMainModule = process.argv[1] && (
    // Direct execution: node device.js
    import.meta.url === `file://${process.argv[1]}` ||
    fileURLToPath(import.meta.url) === process.argv[1] ||
    // Global bin execution: desktop-commander-device (npm creates a wrapper)
    process.argv[1].endsWith('desktop-commander-device') ||
    process.argv[1].endsWith('desktop-commander-device.js')
);

if (isMainModule) {
    // Parse command-line arguments
    const args = process.argv.slice(2);
    const options = {
        // --persist-session is kept as an accepted no-op so existing invocations
        // and docs keep working; --no-persist-session opts back out.
        persistSession: !args.includes('--no-persist-session')
    };

    if (!options.persistSession) {
        console.log('🔓 Session persistence disabled — re-authorization required on every start');
    }

    const device = new MCPDevice(options);
    device.start();
}
