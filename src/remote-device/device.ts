#!/usr/bin/env node

import { ChannelUnreachableError, RemoteChannel, observeServerDate, type AuthSession } from './remote-channel.js';
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
/**
 * Floor between recovery attempts. ensureReady()'s own backoff covers a child
 * that fails to start; this covers one that starts and then fails verification,
 * where no restart backoff was armed and the loop would otherwise spin.
 */
const RECOVERY_MIN_DELAY_MS = 1000;

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
    /**
     * Serialises config writes. Rotations are 45 minutes apart in normal
     * running, but a save that stalls must not land after a newer one and
     * persist a token that is already spent. Shutdown awaits this to drain
     * whatever is still in flight.
     */
    private configWriteChain: Promise<void> = Promise.resolve();
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

        // The session refreshes every 45 minutes and auth-js rotates the refresh
        // token each time. Without this the config keeps whichever token the
        // process started with, and a restart hours later replays a spent one -
        // GoTrue refuses it and an unattended device waits for a browser.
        this.remoteChannel.onSessionRefreshed((session) => void this.savePersistedConfig(session));

        // Initialize desktop integration
        this.desktop = new DesktopCommanderIntegration();

        // Readiness is a claim about executing, so it has to consult the local
        // executor too. Read through a probe rather than a cached flag: there
        // is then no state to keep in step, and `desktop` can be replaced.
        this.remoteChannel.setLocalExecutorProbe(() => this.desktop.ready);

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

            await captureRemote('remote_device_session_state', {
                has_persisted_session: Boolean(session),
                has_persisted_device_id: Boolean(this.deviceId),
            });

            // 2. Set Session or Authenticate
            if (session) {
                const { error } = await this.remoteChannel.setSession(session);

                if (error) {
                    console.log('   - ⚠️ Persisted session invalid:', error.message);
                    session = null;
                } else {
                    console.log('   - ✅ Session restored');

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
                await captureRemote('remote_device_auth_flow_started');
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

            // Register as device. registerDevice() resolves only once the
            // realtime channel is joined and presence is published, which is
            // exactly what the hosted service needs to deliver a call — so a
            // rejection means "running, but nothing can reach this device", and
            // that has to be said instead of "Device ready".
            //
            // Deliberately not fatal, and deliberately not rethrown into the
            // outer catch, which exits the process: the socket watchdog keeps
            // retrying and announces "✅ Channel subscribed" when it gets
            // through, so quitting here would remove the only way back.
            let reachable = true;
            try {
                await this.remoteChannel.registerDevice(
                    await this.desktop.listClientTools(),
                    this.deviceId,
                    deviceName,
                    (payload: any) => this.handleNewToolCall(payload)
                );
            } catch (error: any) {
                // Only a channel fault is recoverable here. A failed lookup or a
                // missing device row happens before registerDevice() stores the
                // recreation parameters, and both checkConnectionHealth() and
                // recreateChannel() return early without them — so nothing in
                // this process could repair it, and swallowing it would promise
                // a retry that can never happen. Those stay fatal, as before.
                if (!(error instanceof ChannelUnreachableError)) throw error;
                reachable = false;
                console.error(`   - ❌ Realtime channel is not open: ${error.message}`);
                await captureRemote('remote_device_registered_unreachable', { error });
            }

            console.log(reachable
                ? '✅ Device ready:'
                : '⚠️  Device registered, but NOT reachable — no command can arrive yet:');
            console.log(`   - User:         ${this.remoteChannel.user!.email}`);
            console.log(`   - Device ID:    ${this.deviceId}`);
            console.log(`   - Device Name:  ${deviceName}`);
            if (!reachable) {
                console.log('   - Retrying in the background; commands start working once you see "✅ Channel subscribed".');
            } else {
                console.log('');
                console.log('✅ Desktop Commander Remote is connected');
                console.log('');
                console.log(`   Device: ${deviceName}`);
                console.log('   Status: Online');
                console.log('');
                console.log('┌─ Next');
                console.log('│ Return to ChatGPT or Claude and continue your conversation.');
                console.log('│ Keep this Terminal running. You can minimize it.');
                console.log('└─ Press Ctrl+C to disconnect.');
                console.log('');
                console.log('┌─ Commands');
                console.log('│ Help:    npx @wonderwhy-er/desktop-commander@latest remote --help');
                console.log('│ Log out: npx @wonderwhy-er/desktop-commander@latest remote --logout');
                console.log('└─ Run these in a new Terminal, or after disconnecting.');
                console.log('');
            }

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

    async clearPersistedConfig() {
        try {
            await fs.rm(this.configPath, { force: true });
            console.debug('[DEBUG] Cleared stale persisted config:', this.configPath);
        } catch (error: any) {
            console.warn('⚠️ Failed to clear stale config:', error.message);
            await captureRemote('remote_device_config_clear_error', { error });
        }
    }

    /**
     * Queue a config write. Returns the queued write, so a caller that must not
     * outlive it - shutdown() - can await it.
     */
    async savePersistedConfig(rotated?: AuthSession): Promise<void> {
        this.configWriteChain = this.configWriteChain.then(() => this.writePersistedConfig(rotated));
        return this.configWriteChain;
    }

    private async writePersistedConfig(rotated?: AuthSession): Promise<void> {
        try {
            console.debug('[DEBUG] Saving persisted config, persistSession:', this.persistSession);
            // Prefer the session TOKEN_REFRESHED handed us over re-reading it. A
            // sign-out landing in that gap answers null, and the write below would
            // replace a usable refresh token with nothing.
            const session = rotated ?? (await this.remoteChannel.getSession()).data.session;

            // Never trade a good token for an empty one. Deliberate clearing is
            // what clearPersistedConfig() is for; --no-persist-session still
            // writes null below, because persistSession is false there.
            if (this.persistSession && !session?.refresh_token) {
                console.debug('[DEBUG] Skipping config save - nothing to persist');
                return;
            }

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
            // Write then rename: the rename is the commit boundary, so a write
            // cut short leaves the previous complete session rather than a
            // truncated file. loadPersistedConfig() answers a JSON.parse
            // failure with null, which costs a full browser reauthorization.
            // Same shape as ConfigManager's atomic save; the pid keeps two
            // processes off each other's temp file, and configWriteChain keeps
            // this one off its own.
            const tempPath = `${this.configPath}.${process.pid}.tmp`;
            await fs.writeFile(tempPath, JSON.stringify(config, null, 2), { mode: 0o600 });
            await fs.rename(tempPath, this.configPath);
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
        // First request of the run, and it already states the server's time.
        // auth-js judges the session handed to setSession() against this
        // device's Date.now() with no skew tolerance, so the clock has to be
        // right BEFORE that call - clockAwareFetch only corrects it afterwards.
        observeServerDate(response.headers.get('date'));

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
        // Through the predicate and its queue, not a direct write: the probe
        // already reads false by the time this runs, and a direct write can be
        // overtaken by an 'online' still sitting in the queue — which would put
        // a device with a dead executor back into the server's selection pool.
        await this.remoteChannel.syncReachabilityStatus()
            .catch((e: any) => console.error('Failed to mark device offline:', e.message));

        // Keep trying, rather than attempting once. The lazy restart in
        // ensureReady() fires on an incoming tool call, and this device is now
        // offline — the hosted service answers a call for an offline device
        // with "No devices available" (confirmed live on 0.2.50), so no call
        // will ever arrive to trigger it. One failed attempt used to mean the
        // device stayed dead until a human restarted the connector.
        let reported = false;
        while (!this.isShuttingDown) {
            try {
                // ensureReady() only reports success once the child has served a
                // request, so reaching here is proof of execution, not just of a
                // completed handshake.
                await this.desktop.ensureReady();
                // Not setOnlineStatus('online'): the executor recovering says
                // nothing about the channel. Let the predicate decide, or this
                // repeats the one-sided claim this whole change removes.
                this.remoteChannel.syncReachabilityStatus();
                console.log('♻️  Local Desktop Commander MCP restarted; device is online again');
                return;
            } catch (error: any) {
                console.error(`❌ Could not restart local Desktop Commander MCP: ${error.message}`);
                // Once per outage, not once per attempt: a device that never
                // recovers would otherwise emit this every backoff window for
                // as long as it runs.
                if (!reported) {
                    reported = true;
                    await captureRemote('remote_device_local_mcp_restart_failed', { error, reason });
                }
                // ensureReady() refuses inside its backoff window; wait it out.
                // The floor covers a child that starts but fails verification,
                // where no restart backoff was armed.
                const waitMs = Math.max(this.desktop.msUntilRestartAllowed, RECOVERY_MIN_DELAY_MS);
                await new Promise((resolve) => setTimeout(resolve, waitMs));
            }
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
            // guard above is what makes execution exactly-once. The doorbell
            // path claims before dispatch and marks the payload `claimed`.
            const claimed = payload.claimed === true || await this.remoteChannel.markCallExecuting(call_id);
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

            // The result write itself notifies the server (a DB trigger).
            await this.remoteChannel.updateCallResult(call_id, 'completed', result);

        } catch (error: any) {
            console.error(`❌ Tool call ${tool_name} failed:`, error.message);
            // The failure path must not fail: this method's promise is discarded
            // at every call site, so a throw here becomes an unhandled rejection
            // and takes the device process down.
            try {
                await captureRemote('remote_device_tool_call_failed', { error, tool_name });
                await this.remoteChannel.updateCallResult(call_id, 'failed', null, error.message);
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

            // Drain any config write still in flight - a rotation can land as
            // teardown begins, and losing it costs the next start a browser.
            console.debug('[DEBUG] Draining pending config writes');
            await this.configWriteChain;

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
