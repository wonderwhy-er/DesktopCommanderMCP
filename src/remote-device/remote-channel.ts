import { createClient, SupabaseClient, Session, UserResponse, User, RealtimeChannel } from '@supabase/supabase-js';
import { captureRemote } from '../utils/capture.js';


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

const HEARTBEAT_INTERVAL = 15000;

export class RemoteChannel {
    private client: SupabaseClient | null = null;
    private channel: RealtimeChannel | null = null;
    private heartbeatInterval: NodeJS.Timeout | null = null;
    private connectionCheckInterval: NodeJS.Timeout | null = null;


    // Store subscription parameters for channel recreation
    private deviceId: string | null = null;
    private onToolCall: ((payload: any) => void) | null = null;

    // Track last device status to prevent duplicate log messages
    private lastDeviceStatus: 'online' | 'offline' = 'offline';

    private _user: User | null = null;
    get user(): User | null { return this._user; }


    initialize(url: string, key: string): void {
        this.client = createClient(url, key);
    }

    async setSession(session: AuthSession): Promise<{ error: any }> {
        if (!this.client) throw new Error('Client not initialized');
        const { error } = await this.client.auth.setSession({
            access_token: session.access_token,
            refresh_token: session.refresh_token || ''
        });
        // Get user info
        const { data: { user }, error: userError } = await this.client.auth.getUser();
        if (userError) throw userError;
        this._user = user;

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

        if (error) throw error;
        return data;
    }

    async updateDevice(deviceId: string, updates: any) {
        if (!this.client) throw new Error('Client not initialized');
        return await this.client
            .from('mcp_devices')
            .update(updates)
            .eq('id', deviceId);
    }

    async createDevice(deviceData: DeviceData) {
        if (!this.client) throw new Error('Client not initialized');
        return await this.client
            .from('mcp_devices')
            .insert(deviceData)
            .select()
            .single();
    }

    async registerDevice(capabilities: any, currentDeviceId: string | undefined, deviceName: string, onToolCall: (payload: any) => void): Promise<void> {


        let existingDevice = null;

        if (currentDeviceId && this.user) {
            existingDevice = await this.findDevice(currentDeviceId);
        }

        if (existingDevice) {
            await this.updateDevice(existingDevice.id, {
                status: 'online',
                last_seen: new Date().toISOString(),
                capabilities: {}, // TODO: Capabilities are not yet implemented; keep this empty object for schema compatibility until device capabilities are defined and stored.
                device_name: deviceName
            });

            // Store parameters for channel recreation
            this.deviceId = existingDevice.id;
            this.onToolCall = onToolCall;

            console.debug(`⏳ Subscribing to tool call channel...`);

            // Create and subscribe to the channel
            await this.createChannel();
        } else {
            console.error(`   - ❌ Device not found: ${currentDeviceId}`);
            await captureRemote('remote_channel_register_device_error', { error: 'Device not found', deviceId: currentDeviceId });
            throw new Error(`Device not found: ${currentDeviceId}`);
        }
    }


    async subscribe(deviceId: string, onToolCall: (payload: any) => void): Promise<void> {
        if (!this.client) throw new Error('Client not initialized');

        // Store parameters for channel recreation
        this.deviceId = deviceId;
        this.onToolCall = onToolCall;

        console.debug(`⏳ Subscribing to tool call channel...`);

        // Create and subscribe to the channel
        await this.createChannel();
    }

    /**
     * Create and subscribe to the channel.
     * This is used for both initial subscription and recreation after socket reconnects.
     */
    private createChannel(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.client || !this.user?.id || !this.onToolCall) {
                return reject(new Error('Client not initialized or missing subscription parameters'));
            }

            this.channel = this.client.channel('device_tool_call_queue')
                .on(
                    'postgres_changes' as any,
                    {
                        event: 'INSERT',
                        schema: 'public',
                        table: 'mcp_remote_calls',
                        filter: `user_id=eq.${this.user.id}`
                    },
                    (payload: any) => {
                        if (this.onToolCall) {
                            this.onToolCall(payload);
                        }
                    }
                )
                .subscribe((status: string, err: any) => {
                    if (status === 'SUBSCRIBED') {
                        console.log('✅ Channel subscribed');
                        // Update device status on successful connection
                        if (this.deviceId) {
                            this.setOnlineStatus(this.deviceId, 'online').catch(e => {
                                console.error('Failed to set online status:', e.message);
                            });
                        }
                        resolve();
                    } else if (status === 'CHANNEL_ERROR') {
                        // console.error('❌ Channel subscription failed:', err);
                        this.setOnlineStatus(this.deviceId!, 'offline');
                        captureRemote('remote_channel_subscription_error', { error: err || 'Channel error' }).catch(() => { });
                        reject(err || new Error('Failed to initialize tool call channel subscription'));
                    } else if (status === 'TIMED_OUT') {
                        console.error('⏱️ Channel subscription timed out');
                        this.setOnlineStatus(this.deviceId!, 'offline');
                        captureRemote('remote_channel_subscription_timeout', {}).catch(() => { });
                        reject(new Error('Tool call channel subscription timed out'));
                    }
                });
        });
    }

    /**
     * Check if channel is connected, recreate if not.
     */
    private checkConnectionHealth(): void {
        if (!this.channel || !this.client || !this.user?.id || !this.onToolCall) {
            return;
        }

        const state = this.channel.state;

        // If channel is in error or closed state, recreate it
        if (state === 'closed' || state === 'errored') {
            // console.log(`⚠️ Channel in ${state} state - recreating...`);
            this.recreateChannel();
        }
    }

    /**
     * Recreate the channel by destroying old one and creating fresh instance.
     */
    private recreateChannel(): void {
        if (!this.client || !this.user?.id || !this.onToolCall) {
            console.warn('Cannot recreate channel - missing parameters');
            return;
        }

        // Destroy old channel
        if (this.channel) {
            // console.debug('🔄 Destroying old channel');
            this.client.removeChannel(this.channel);
            this.channel = null;
        }

        // Create fresh channel
        console.log('🔄 Recreating channel...');
        this.createChannel().catch(err => {
            // TODO: enable only for debug mode
            // console.error('Failed to recreate channel:', err);
        });
    }

    async markCallExecuting(callId: string) {
        if (!this.client) throw new Error('Client not initialized');
        await this.client
            .from('mcp_remote_calls')
            .update({ status: 'executing' })
            .eq('id', callId);
    }

    async updateCallResult(callId: string, status: string, result: any = null, errorMessage: string | null = null) {
        if (!this.client) throw new Error('Client not initialized');
        const updateData: any = {
            status: status,
            completed_at: new Date().toISOString()
        };

        if (result !== null) updateData.result = result;
        if (errorMessage !== null) updateData.error_message = errorMessage;

        await this.client
            .from('mcp_remote_calls')
            .update(updateData)
            .eq('id', callId);
    }

    async updateHeartbeat(deviceId: string) {
        if (!this.client) return;
        try {
            await this.client
                .from('mcp_devices')
                .update({ last_seen: new Date().toISOString() })
                .eq('id', deviceId);
            // console.log(`🔌 Heartbeat sent for device: ${deviceId}`);
        } catch (error: any) {
            console.error('Heartbeat failed:', error.message);
            await captureRemote('remote_channel_heartbeat_error', { error });
        }
    }

    startHeartbeat(deviceId: string) {
        this.connectionCheckInterval = setInterval(() => {
            this.checkConnectionHealth();
        }, 10000);

        // Update last_seen every 15 seconds
        this.heartbeatInterval = setInterval(async () => {
            await this.updateHeartbeat(deviceId);
        }, HEARTBEAT_INTERVAL);
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
            if (status == "online") {
                console.error('Failed to update device status:', error.message);
            }
            await captureRemote('remote_channel_status_update_error', { error, status });
            return;
        }

        // console.log(status === 'online' ? `🔌 Device marked as ${status}` : `❌ Device marked as ${status}`);
    }

    async setOffline(deviceId: string | undefined) {
        if (!deviceId || !this.client) {
            return;
        }

        // console.log('🔍 [setOffline] Initiating blocking update...');

        try {
            // Get current session for the subprocess
            const { data: sessionData } = await this.client.auth.getSession();

            if (!sessionData?.session?.access_token) {
                console.error('❌ No valid session for offline update');
                return;
            }

            // Get Supabase config from client
            const supabaseUrl = (this.client as any).supabaseUrl;
            const supabaseKey = (this.client as any).supabaseKey;

            if (!supabaseUrl || !supabaseKey) {
                console.error('❌ Missing Supabase configuration');
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
            await captureRemote('remote_channel_offline_update_error', { error });
        }
    }

    async unsubscribe() {
        if (this.channel) {
            await this.channel.unsubscribe();
            this.channel = null;
            console.log('✓ Unsubscribed from tool call channel');
        }
    }
}
