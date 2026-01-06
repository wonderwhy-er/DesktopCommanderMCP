import { createClient } from '@supabase/supabase-js';

const HEARTBEAT_INTERVAL = 30000;

export class RemoteChannel {
    constructor() {
        this.client = null;
        this.channel = null;
        this.heartbeatInterval = null;
    }

    initialize(url, key) {
        this.client = createClient(url, key);
    }

    async setSession(session) {
        return await this.client.auth.setSession({
            access_token: session.access_token,
            refresh_token: session.refresh_token
        });
    }

    async getSession() {
        return await this.client.auth.getSession();
    }

    async getUser() {
        return await this.client.auth.getUser();
    }

    onAuthStateChange(callback) {
        return this.client.auth.onAuthStateChange(callback);
    }

    async findDevice(deviceId, userId) {
        const { data, error } = await this.client
            .from('mcp_devices')
            .select('id, device_name')
            .eq('id', deviceId)
            .eq('user_id', userId)
            .maybeSingle();

        if (error) throw error;
        return data;
    }

    async updateDevice(deviceId, updates) {
        return await this.client
            .from('mcp_devices')
            .update(updates)
            .eq('id', deviceId);
    }

    async createDevice(deviceData) {
        return await this.client
            .from('mcp_devices')
            .insert(deviceData)
            .select()
            .single();
    }

    async registerDevice(userId, capabilities, currentDeviceId, deviceName) {
        let existingDevice = null;

        if (currentDeviceId) {
            try {
                existingDevice = await this.findDevice(currentDeviceId, userId);
            } catch (e) {
                // ignore error, treat as not found
                console.warn('Error checking existing device:', e.message);
            }
        }

        if (existingDevice) {
            console.log(`🔍 Found existing device: ${existingDevice.device_name} (${existingDevice.id})`);

            await this.updateDevice(existingDevice.id, {
                status: 'online',
                last_seen: new Date().toISOString(),
                capabilities: capabilities,
                device_name: deviceName
            });

            return existingDevice.id;

        } else {
            if (currentDeviceId) {
                console.warn(`⚠️ persisted deviceId ${currentDeviceId} not found for user ${userId}. Creating new device...`);
            } else {
                console.log('📝 No existing device found, creating new registration...');
            }

            const { data: newDevice, error } = await this.createDevice({
                user_id: userId,
                device_name: deviceName,
                capabilities: capabilities,
                status: 'online',
                last_seen: new Date().toISOString()
            });

            if (error) throw error;

            console.log(`✓ Device registered: ${newDevice.device_name}`);
            console.log(`✓ Assigned new Device ID: ${newDevice.id}`);
            return newDevice.id;
        }
    }

    async subscribe(userId, onToolCall) {
        console.debug(` - ⏳ Subscribing to call queue...`);

        return new Promise((resolve, reject) => {
            this.channel = this.client.channel('device_tool_call_queue')
                .on(
                    'postgres_changes',
                    {
                        event: 'INSERT',
                        schema: 'public',
                        table: 'mcp_remote_calls',
                        filter: `user_id=eq.${userId}`
                    },
                    (payload) => onToolCall(payload)
                )
                .subscribe((status, err) => {
                    // console.log(`Subscription status: ${status}`);
                    if (status === 'SUBSCRIBED') {
                        console.debug(' - 🔌 Connected to call queue');
                        resolve();
                    } else if (status === 'CHANNEL_ERROR') {
                        console.error(' - ❌ Failed to connect to call queue:', err);
                        reject(err || new Error('Failed to initialize call queue subscription'));
                    } else if (status === 'TIMED_OUT') {
                        console.error(' - ❌ Connection to call queue timed out');
                        reject(new Error('Call queue subscription timed out'));
                    }
                });
        });
    }

    async markCallExecuting(callId) {
        await this.client
            .from('mcp_remote_calls')
            .update({ status: 'executing' })
            .eq('id', callId);
    }

    async updateCallResult(callId, status, result = null, errorMessage = null) {
        const updateData = {
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

    async updateHeartbeat(deviceId) {
        try {
            await this.client
                .from('mcp_devices')
                .update({ last_seen: new Date().toISOString() })
                .eq('id', deviceId);
        } catch (error) {
            console.error('Heartbeat failed:', error.message);
        }
    }

    startHeartbeat(deviceId) {
        // Update last_seen every 30 seconds
        this.heartbeatInterval = setInterval(async () => {
            await this.updateHeartbeat(deviceId);
        }, HEARTBEAT_INTERVAL);
    }

    async setOffline(deviceId) {
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
            clearInterval(this.heartbeatInterval);
            await this.channel.unsubscribe();
            console.log('✓ Unsubscribed from channel');
        }
    }
}
