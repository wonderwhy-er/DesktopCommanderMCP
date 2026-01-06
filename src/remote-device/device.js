#!/usr/bin/env node

import { RemoteChannel } from './remote-channel.js';
import { DeviceAuthenticator } from './device-authenticator.js';
import { DesktopCommanderIntegration } from './desktop-commander-integration.js';
import { fileURLToPath } from 'url';
import os from 'os';
import fs from 'fs/promises';
import path from 'path';


class MCPDevice {
    constructor(options = {}) {
        this.baseServerUrl = process.env.MCP_SERVER_URL || 'https://mcp.desktopcommander.app';
        this.remoteChannel = new RemoteChannel();
        this.deviceId = null;
        this.user = null;
        this.isShuttingDown = false;
        this.configPath = path.join(os.homedir(), '.desktop-commander-device', 'device.json');
        this.persistSession = options.persistSession || false;

        // Initialize desktop integration
        this.desktop = new DesktopCommanderIntegration();

        // Graceful shutdown handlers (only set once)
        this.setupShutdownHandlers();
    }

    setupShutdownHandlers() {
        const handleShutdown = async (signal) => {
            if (this.isShuttingDown) {
                console.log(`\n${signal} received, but already shutting down...`);
                return;
            }

            console.log(`\n${signal} received, initiating graceful shutdown...`);
            await this.shutdown();
        };

        process.on('SIGINT', () => {
            handleShutdown('SIGINT').finally(() => process.exit(0));
        });
        process.on('SIGTERM', () => {
            handleShutdown('SIGTERM').finally(() => process.exit(0));
        });

        // Handle uncaught exceptions
        process.on('uncaughtException', (error) => {
            console.error('Uncaught exception:', error);
            handleShutdown('uncaughtException').finally(() => process.exit(1));
        });

        process.on('unhandledRejection', (reason, promise) => {
            console.error('Unhandled rejection at:', promise, 'reason:', reason);
            handleShutdown('unhandledRejection').finally(() => process.exit(1));
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
                session = await authenticator.authenticate();

                // Set session in Remote Channel
                const { error } = await this.remoteChannel.setSession(session);

                if (error) throw error;
            }

            // 3. Setup Token Refresh Listener
            this.remoteChannel.onAuthStateChange(async (event, newSession) => {
                const eventMap = {
                    'SIGNED_IN': '🔑 User signed in',
                    'TOKEN_REFRESHED': '🔄 Token refreshed',
                    'SIGNED_OUT': '⚠️ User signed out',
                };
                if (eventMap[event]) {
                    console.log(eventMap[event]);
                }
            });

            // Force save the current session immediately to ensure it's persisted
            await this.savePersistedConfig(
                (await this.remoteChannel.getSession()).data.session
            );

            // Get user info
            const { data: { user }, error: userError } = await this.remoteChannel.getUser();
            if (userError) throw userError;
            this.user = user;

            const deviceName = os.hostname();
            // Register as device
            this.deviceId = await this.remoteChannel.registerDevice(
                this.user.id,
                await this.desktop.getCapabilities(),
                this.deviceId,
                deviceName
            );

            // Also save session again just in case (optional, but harmless)
            const { data: { session: currentSession } } = await this.remoteChannel.getSession();
            await this.savePersistedConfig(currentSession);

            // Subscribe to tool calls
            await this.remoteChannel.subscribe(this.user.id, (payload) => this.handleNewToolCall(payload));

            console.log('✅ Device ready:');
            console.log(`   - Device ID:    ${this.deviceId}`);
            console.log(`   - Device Name:  ${deviceName}`);

            // Keep process alive
            this.remoteChannel.startHeartbeat(this.deviceId);

        } catch (error) {
            console.error(' - ❌ Device startup failed:', error.message);
            if (error.stack && process.env.DEBUG_MODE === 'true') {
                console.error('Stack trace:', error.stack);
            }
            await this.shutdown();
            process.exit(1);
        }
    }


    async loadPersistedConfig() {
        try {
            const data = await fs.readFile(this.configPath, 'utf8');
            const config = JSON.parse(data);

            this.deviceId = config?.deviceId;

            console.log('💾 Found persisted session for device ' + this.deviceId);
            if (config.session) {
                return config.session;
            }

            return null;
        } catch (error) {

            if (error.code !== 'ENOENT') {
                console.warn('⚠️ Failed to load config:', error.message);
            }
            return null;
        } finally {
            // No need to ensure device ID here
        }
    }

    async savePersistedConfig(session) {
        try {
            const config = {
                deviceId: this.deviceId,
                // Only save session if --persist-session flag is set
                session: (session && this.persistSession) ? {
                    access_token: session.access_token,
                    refresh_token: session.refresh_token
                } : null
            };

            // Ensure the config directory exists
            await fs.mkdir(path.dirname(this.configPath), { recursive: true });
            await fs.writeFile(this.configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
            // if (session) console.debug('💾 Session saved to device.json');
        } catch (error) {
            console.error(' - ❌ Failed to save config:', error.message);
        }
    }

    async fetchSupabaseConfig() {
        // No auth header needed for this public endpoint
        const response = await fetch(`${this.baseServerUrl}/api/mcp-info`);

        if (!response.ok) {
            throw new Error(`Failed to fetch Supabase config: ${response.statusText}`);
        }

        const config = await response.json();
        return {
            supabaseUrl: config.supabaseUrl,
            anonKey: config.supabaseAnonKey
        };
    }

    // Methods moved to RemoteChannel

    async handleNewToolCall(payload) {
        const toolCall = payload.new;
        // Assuming database also renames agent_id to device_id, but user only said rename agent -> device everywhere but only inside src/remote-device
        // If the database column is still agent_id, we need a mapping.
        // However, the user said "literally all agent should be renamed to device everywhere", so we assume DB column is device_id.
        const { id: call_id, tool_name, tool_args, device_id } = toolCall;

        // Only process jobs for this device
        if (device_id && device_id !== this.deviceId) {
            return;
        }

        console.log(`🔧 Received tool call ${call_id}: ${tool_name} ${JSON.stringify(tool_args)}`);

        try {
            // Update call status to executing
            await this.remoteChannel.markCallExecuting(call_id);

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
                result = await this.desktop.executeTool(tool_name, tool_args);
            }

            console.log(`✅ Tool call ${tool_name} completed:\r\n ${JSON.stringify(result)}`);

            // Update database with result
            await this.remoteChannel.updateCallResult(call_id, 'completed', result);

        } catch (error) {
            console.error(`❌ Tool call ${tool_name} failed:`, error.message);
            await this.remoteChannel.updateCallResult(call_id, 'failed', null, error.message);
        }
    }

    // Moved to RemoteChannel

    // Moved to RemoteChannel

    async shutdown() {
        if (this.isShuttingDown) {
            return;
        }

        this.isShuttingDown = true;
        console.log('\n🛑 Shutting down device...');

        try {
            // Remote shutdown
            await this.remoteChannel.unsubscribe();
            await this.remoteChannel.setOffline(this.deviceId);

            // Shutdown desktop integration
            await this.desktop.shutdown();

            console.log('✓ Device shutdown complete');
        } catch (error) {
            console.error('Shutdown error:', error.message);
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
        persistSession: args.includes('--persist-session')
    };

    if (options.persistSession) {
        console.log('🔒 Session persistence enabled');
    }

    const device = new MCPDevice(options);
    device.start();
}

export default MCPDevice;
