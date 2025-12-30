export class ChannelManager {
  constructor(supabase) {
    this.supabase = supabase;
    this.userChannels = new Map(); // userId -> channel
    this.listeners = new Map(); // event -> callback
  }

  // Subscribe to user-specific channel
  async subscribeToUser(userId) {
    const channelName = `mcp_user_${userId}`;
    
    const channel = this.supabase.channel(channelName)
      .on('broadcast', { event: 'tool_call' }, (payload) => {
        this.handleToolCall(userId, payload);
      })
      .on('broadcast', { event: 'tool_result' }, (payload) => {
        this.handleToolResult(userId, payload);
      })
      .on('presence', { event: 'sync' }, () => {
        this.handlePresenceSync(userId, channelName);
      })
      .on('presence', { event: 'join' }, (payload) => {
        this.handlePresenceJoin(userId, payload);
      })
      .on('presence', { event: 'leave' }, (payload) => {
        this.handlePresenceLeave(userId, payload);
      })
      .subscribe();

    this.userChannels.set(userId, channel);
    return channel;
  }

  // Broadcast tool call to agents
  async broadcastToolCall(userId, toolCall) {
    console.log(`📡 [CHANNEL] Broadcasting tool call to user ${userId}:`, toolCall);
    
    const channel = this.userChannels.get(userId);
    if (!channel) {
      console.error(`❌ [CHANNEL] No channel found for user ${userId}`);
      console.log(`🔍 [CHANNEL] Available channels:`, Array.from(this.userChannels.keys()));
      throw new Error(`No channel found for user ${userId}`);
    }

    console.log(`✅ [CHANNEL] Found channel for user ${userId}, sending broadcast`);
    
    try {
      const result = await channel.send({
        type: 'broadcast',
        event: 'tool_call',
        payload: toolCall
      });
      console.log(`✅ [CHANNEL] Broadcast sent successfully:`, result);
      return result;
    } catch (error) {
      console.error(`❌ [CHANNEL] Failed to send broadcast:`, error);
      throw error;
    }
  }

  // Broadcast tool result back to server
  async broadcastToolResult(userId, result) {
    const channel = this.userChannels.get(userId);
    if (!channel) {
      throw new Error(`No channel found for user ${userId}`);
    }

    return channel.send({
      type: 'broadcast',
      event: 'tool_result',
      payload: result
    });
  }

  // Event handlers
  handleToolCall(userId, payload) {
    const callback = this.listeners.get('tool_call');
    if (callback) {
      callback(userId, payload);
    }
  }

  handleToolResult(userId, payload) {
    const callback = this.listeners.get('tool_result');
    if (callback) {
      callback(userId, payload);
    }
  }

  handlePresenceSync(userId, channelName) {
    const channel = this.userChannels.get(userId);
    if (channel) {
      const presenceState = channel.presenceState();
      console.log(`Presence sync for user ${userId}:`, presenceState);
    }
  }

  handlePresenceJoin(userId, payload) {
    console.log(`Agent joined for user ${userId}:`, payload);
  }

  handlePresenceLeave(userId, payload) {
    console.log(`Agent left for user ${userId}:`, payload);
  }

  // Register event listeners
  on(event, callback) {
    this.listeners.set(event, callback);
  }

  // Unsubscribe from user channel
  async unsubscribeFromUser(userId) {
    const channel = this.userChannels.get(userId);
    if (channel) {
      await channel.unsubscribe();
      this.userChannels.delete(userId);
    }
  }

  // Get active agents for user
  getActiveAgents(userId) {
    const channel = this.userChannels.get(userId);
    if (!channel) return [];

    const presenceState = channel.presenceState();
    return Object.values(presenceState).flat();
  }

  // Cleanup all channels
  async cleanup() {
    for (const [userId, channel] of this.userChannels) {
      await channel.unsubscribe();
    }
    this.userChannels.clear();
    this.listeners.clear();
  }
}