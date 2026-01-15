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

const HEARTBEAT_INTERVAL = 30000;

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
                capabilities: {}, // Not used atm
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
                        console.debug(' - 🔌 Connected to tool call channel');
                        resolve();
                    } else if (status === 'CHANNEL_ERROR') {
                        console.error(' - ❌ Failed to connect to tool call channel:', err);
                        reject(err || new Error('Failed to initialize tool call channel subscription'));
                    } else if (status === 'TIMED_OUT') {
                        console.error(' - ❌ Connection to tool call channel timed out');
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

    async setOffline(deviceId: string | undefined) {
        if (deviceId && this.client) {
            await this.client
                .from('mcp_devices')
                .update({ status: 'offline' })
                .eq('id', deviceId);
            console.log('✓ Device marked as offline');
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
