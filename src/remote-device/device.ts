#!/usr/bin/env node

import { MAX_CONCURRENT_REMOTE_CALLS, RemoteChannel } from './remote-channel.js';
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
 * Bounded cache of recently claimed ids to skip repeated notifications locally.
 * Active calls live separately so eviction cannot admit concurrent duplicates.
 * The database claim, not this cache or MQTT QoS, arbitrates across processes.
 */
const SEEN_CALL_IDS_MAX = 100;

export class MCPDevice {
    private baseServerUrl: string;
    private remoteChannel: RemoteChannel;
    private deviceId?: string;
    private isShuttingDown: boolean;
    private configPath: string;
    private persistSession: boolean;
    private desktop: DesktopCommanderIntegration;
    /** Call ids already handled by THIS process (insertion-ordered, bounded). */
    private seenCallIds: Set<string> = new Set();
    /** Admission stays occupied from claim through terminal result reporting. */
    private inFlightCallIds: Set<string> = new Set();

    /** Wire remote delivery to the local MCP executor; startup later loads the chosen profile. */
    constructor(options: MCPDeviceOptions = {}) {
        this.baseServerUrl = process.env.MCP_SERVER_URL || 'https://mcp.desktopcommander.app';
        this.deviceId = undefined;
        this.isShuttingDown = false;
        // Separate local profiles let teammates simulate multiple registered devices without
        // overwriting the default device id/session file. This is a path, not an identity override.
        this.configPath = process.env.MCP_DEVICE_CONFIG_PATH ||
            path.join(os.homedir(), '.desktop-commander-device', 'device.json');
        // Enrollment uses this same backend and profile so credentials cannot cross device identities.
        this.remoteChannel = new RemoteChannel({ serverUrl: this.baseServerUrl, profilePath: this.configPath });
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

    private setupShutdownHandlers() {
        const handleShutdown = async (signal: string) => {
            if (this.isShuttingDown) {
                console.log(`\n${signal} received, but already shutting down...`);
                // Force exit if we get multiple signals
                process.exit(1);
                return;
            }

            console.log(`\n${signal} received, initiating graceful shutdown...`);

            // Force exit after 5 seconds if graceful shutdown hangs
            const forceExit = setTimeout(() => {
                console.error('\n⚠️ Graceful shutdown timed out, forcing exit...');
                process.exit(1);
            }, 5000);

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


            // Force save the current session immediately to ensure it's persisted
            await this.savePersistedConfig();

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

    async savePersistedConfig() {
        try {
            console.debug('[DEBUG] Saving persisted config, persistSession:', this.persistSession);
            const currentSessionStore = await this.remoteChannel.getSession();
            const session = currentSessionStore.data.session;

            const config = {
                deviceId: this.deviceId,
                // Only save session if --persist-session flag is set
                session: (session && this.persistSession) ? {
                    access_token: session.access_token,
                    refresh_token: session.refresh_token
                } : null
            };
            // Ensure the config directory exists
            console.debug('[DEBUG] Creating config directory:', path.dirname(this.configPath));
            await fs.mkdir(path.dirname(this.configPath), { recursive: true });
            await fs.writeFile(this.configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
            console.debug('[DEBUG] Config saved to:', this.configPath);
        } catch (error: any) {
            console.error(' - ❌ Failed to save config:', error.message);
            console.debug('[DEBUG] Config save error details:', error);
            await captureRemote('remote_device_config_save_error', { error });
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

    /**
     * RemoteChannel hands both transports' fetched rows here. Validate and atomically claim
     * the row, call the local executor, then persist the result before notifying the server.
     * Claim arbitration prevents duplicate admission; it cannot make external side effects
     * and a database result write one exactly-once transaction.
     */
    async handleNewToolCall(payload: any) {
        const toolCall = payload?.new;
        if (!toolCall || this.isShuttingDown) return;
        const observe = (stage: string, reason?: string) => {
            try { this.remoteChannel.recordTransportStage(payload.transportObservation, stage, reason, payload.transportGeneration); }
            catch { /* analytics cannot interrupt execution */ }
        };
        const { id: call_id, tool_name, tool_args, device_id, user_id, metadata = {} } = toolCall;
        // Revalidate even for direct callers: doorbell checks are not the execution boundary.
        // Prefer the row deadline while retaining the metadata form used by older callers.
        const deadline = toolCall.timeout_at ?? metadata.expires_at;
        if (!call_id || !this.deviceId || device_id !== this.deviceId ||
            !this.remoteChannel.user || user_id !== this.remoteChannel.user.id ||
            toolCall.status !== 'pending' ||
            (deadline && (!Number.isFinite(Date.parse(deadline)) || Date.parse(deadline) <= Date.now()))) return;

        // Hold in-flight ids separately: evicting an old completed id must never
        // evict an active execution. Database claims protect other processes.
        if (this.seenCallIds.has(call_id) || this.inFlightCallIds.has(call_id)) {
            observe('handling_rejected', 'duplicate'); return;
        }
        if (this.inFlightCallIds.size >= MAX_CONCURRENT_REMOTE_CALLS) {
            observe('handling_rejected', 'concurrency_limit'); return;
        }
        this.inFlightCallIds.add(call_id);
        let claimed = false;
        const sessionGeneration = this.remoteChannel.sessionGeneration;
        // Used after the claim and again by DesktopCommanderIntegration after child restart.
        // A restored session has a new generation even when its user/device ids are unchanged.
        const assertCanExecute = () => {
            if (this.isShuttingDown ||
                !this.remoteChannel.canExecuteCall(user_id, device_id, sessionGeneration) ||
                (deadline && Date.parse(deadline) <= Date.now())) {
                observe('handling_rejected', deadline && Date.parse(deadline) <= Date.now() ? 'expired' : 'unavailable');
                throw new Error('Command expired or device session changed before execution');
            }
        };
        try {
            claimed = await this.remoteChannel.markCallExecuting(call_id, deadline);
            if (!claimed) { observe('handling_rejected', 'claim_lost'); return; }
            // Remember only a confirmed claim; a failed claim must remain safe to retry later.
            this.rememberCallId(call_id);
            assertCanExecute();

            let result;

            // Handle 'ping' tool specially
            if (tool_name === 'ping') {
                observe('execution_start');
                result = {
                    content: [{
                        type: 'text',
                        text: `pong ${new Date().toISOString()}`
                    }]
                };
            } else if (tool_name === 'shutdown') {
                observe('execution_start');
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
                result = await this.desktop.callClientTool(tool_name, tool_args, metadata, assertCanExecute,
                    () => observe('execution_start'), call_id);
            }

            console.debug('[DEBUG] Tool call completed:', call_id);

            // Update database with result, THEN ring the doorbell — the server
            // fetches the row by id on the doorbell, so the write must land first.
            await this.remoteChannel.updateCallResult(call_id, 'completed', result);
            await this.remoteChannel.notifyResult(call_id);

        } catch (error: any) {
            if (!claimed) return; // a failed/ambiguous claim must not overwrite another execution
            console.error('❌ Tool call failed', { call_id });
            // RemoteChannel now awaits this handler to hold admission through reporting.
            // Contain reporting failures too: a failed result write must not escape cleanup
            // or trigger another execution of a command whose claim already succeeded.
            try {
                await captureRemote('remote_device_tool_call_failed', { call_id, tool_name });
                await this.remoteChannel.updateCallResult(call_id, 'failed', null, error.message);
                await this.remoteChannel.notifyResult(call_id);
            } catch (reportError: any) {
                console.error('❌ Could not report call failure', { call_id });
            }
        } finally {
            // Release on every outcome, including bounded database failures, so later work fits.
            this.inFlightCallIds.delete(call_id);
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
            // Stop heartbeat first to prevent new operations
            console.log('  → Stopping heartbeat...');
            console.debug('[DEBUG] Calling stopHeartbeat()');
            this.remoteChannel.stopHeartbeat();
            console.log('  ✓ Heartbeat stopped');

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
