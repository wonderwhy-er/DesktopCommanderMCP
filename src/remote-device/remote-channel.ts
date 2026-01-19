import { createClient, SupabaseClient, Session, UserResponse, RealtimeChannel } from '@supabase/supabase-js';

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

    initialize(url: string, key: string): void {
        this.client = createClient(url, key);
    }

    async setSession(session: AuthSession): Promise<{ error: any }> {
        if (!this.client) throw new Error('Client not initialized');
        const { error } = await this.client.auth.setSession({
            access_token: session.access_token,
            refresh_token: session.refresh_token || ''
        });
        return { error };
    }

    async getSession(): Promise<{ data: { session: Session | null }; error: any }> {
        if (!this.client) throw new Error('Client not initialized');
        return await this.client.auth.getSession();
    }

    async getUser(): Promise<UserResponse> {
        if (!this.client) throw new Error('Client not initialized');
        return await this.client.auth.getUser();
    }

    onAuthStateChange(callback: (event: string, session: Session | null) => void) {
        if (!this.client) throw new Error('Client not initialized');
        return this.client.auth.onAuthStateChange(callback);
    }

    async findDevice(deviceId: string, userId: string) {
        if (!this.client) throw new Error('Client not initialized');
        const { data, error } = await this.client
            .from('mcp_devices')
            .select('id, device_name')
            .eq('id', deviceId)
            .eq('user_id', userId)
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

    async registerDevice(userId: string, capabilities: any, currentDeviceId: string | undefined, deviceName: string): Promise<void> {
        let existingDevice = null;

        if (currentDeviceId) {
            existingDevice = await this.findDevice(currentDeviceId, userId);
        }

        if (existingDevice) {
            console.log(`🔍 Found existing device: ${existingDevice.device_name} (${existingDevice.id})`);

            await this.updateDevice(existingDevice.id, {
                status: 'online',
                last_seen: new Date().toISOString(),
                capabilities: {}, // TODO: Capabilities are not yet implemented; keep this empty object for schema compatibility until device capabilities are defined and stored.
                device_name: deviceName
            });
        } else {
            console.error(`   - ❌ Device not found: ${currentDeviceId}`);
            throw new Error(`Device not found: ${currentDeviceId}`);
        }
    }


    async subscribe(userId: string, onToolCall: (payload: any) => void): Promise<void> {
        if (!this.client) throw new Error('Client not initialized');
        console.debug(` - ⏳ Subscribing to tool call channel...`);

        return new Promise((resolve, reject) => {
            if (!this.client) return reject(new Error('Client not initialized'));

            this.channel = this.client.channel('device_tool_call_queue')
                .on(
                    'postgres_changes' as any,
                    {
                        event: 'INSERT',
                        schema: 'public',
                        table: 'mcp_remote_calls',
                        filter: `user_id=eq.${userId}`
                    },
                    (payload: any) => onToolCall(payload)
                )
                .subscribe((status: string, err: any) => {
                    if (status === 'SUBSCRIBED') {
                        // console.debug(' - 🔌 Connected to tool call channel');
                        this.setOnlineStatus(userId, 'online');
                        resolve();
                    } else if (status === 'CHANNEL_ERROR') {
                        // console.error(' - ❌ Failed to connect to tool call channel:', err);
                        this.setOnlineStatus(userId, 'offline');
                        reject(err || new Error('Failed to initialize tool call channel subscription'));
                    } else if (status === 'TIMED_OUT') {
                        // console.error(' - ❌ Connection to tool call channel timed out');
                        this.setOnlineStatus(userId, 'offline');
                        reject(new Error('Tool call channel subscription timed out'));
                    }
                });
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
        }
    }

    startHeartbeat(deviceId: string) {
        // Update last_seen every 30 seconds
        this.heartbeatInterval = setInterval(async () => {
            await this.updateHeartbeat(deviceId);
        }, HEARTBEAT_INTERVAL);
    }

    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    async setOnlineStatus(deviceId: string, status: 'online' | 'offline') {
        if (!this.client) return;
        const { error } = await this.client
            .from('mcp_devices')
            .update({ status: status, last_seen: new Date().toISOString() })
            .eq('id', deviceId);

        if (error) {
            console.error('Failed to update device status:', error.message);
            return;
        }

        console.log(status === 'online' ? `🔌 Device marked as ${status}` : `❌ Device marked as ${status}`);
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
