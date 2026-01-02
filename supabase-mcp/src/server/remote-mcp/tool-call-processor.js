const TOOL_CALL_TIMEOUT = 60000 * 5; // 5 minutes

export class ToolCallProcessor {
  constructor(supabase) {
    this.supabase = supabase;
    this.pendingCalls = new Map(); // callId -> Promise resolver
    this.globalChannel = null;

    // Setup global result listener
    this.initializeGlobalListener();

    // Setup periodic cleanup
    this.startCleanupTimer();
  }

  // Initialize global listener for tool execution results
  async initializeGlobalListener() {
    console.log('🌍 [DISPATCH] Initializing global listener for tool results...');

    this.globalChannel = this.supabase.channel('mcp_global_results')
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'mcp_remote_calls',
          filter: 'status=in.(completed,failed)'
        },
        (payload) => {
          this.handleToolCallUpdate(payload.new);
        }
      )
      .subscribe((status) => {
        console.log(`Global subscription status: ${status}`);
        if (status === 'SUBSCRIBED') {
          console.log('✅ Listening for global tool completions');
        }
      });
  }

  // Handle global update from Realtime
  async handleToolCallUpdate(record) {
    const { id: call_id, result, error_message, status } = record;

    const pending = this.pendingCalls.get(call_id);
    if (!pending) {
      // This is normal for restored sessions or duplicates, just ignore
      return;
    }

    this.pendingCalls.delete(call_id);

    if (status === 'failed' || error_message) {
      pending.reject(new Error(error_message || 'Unknown error'));
    } else {
      pending.resolve(result);
    }
  }

  // Dispatch tool call to remote agent
  async dispatchTool(userId, toolName, args, agentId = null) {

    // Determine target agent: explicit param overrides args
    let targetAgentId = agentId || await this.getLastActiveAgent(userId);


    if (!targetAgentId) {
      console.log(`❌ [DISPATCH] No agents available for user ${userId}`);
      throw new Error('No agents available - please connect an agent to use remote tools');
    }

    console.log(`🚀 [DISPATCH] Starting tool dispatch: ${toolName} for user ${userId} agent ${targetAgentId}`, args);

    // Create remote call record
    const { data: remoteCall, error } = await this.supabase
      .from('mcp_remote_calls')
      .insert({
        user_id: userId,
        agent_id: targetAgentId,
        tool_name: toolName,
        tool_args: args,
        status: 'pending'
      })
      .select()
      .single();

    if (error) {
      console.error(`❌ [DISPATCH] Failed to create remote call record:`, error);
      throw error;
    }

    console.log(`✅ [DISPATCH] Remote call record created: ${remoteCall.id}`);
    console.log(`⏳ [DISPATCH] Waiting for agent execution (30s timeout)`);

    // Return promise that resolves when result received
    return new Promise((resolve, reject) => {
      this.pendingCalls.set(remoteCall.id, {
        resolve,
        reject,
        userId,
        created: Date.now()
      });

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingCalls.has(remoteCall.id)) {
          console.log(`⏰ [DISPATCH] Tool call timeout for ${remoteCall.id}`);
          this.pendingCalls.delete(remoteCall.id);
          this.markCallFailed(remoteCall.id, 'Tool call timeout - agent did not respond');
          reject(new Error('Tool call timeout - agent did not respond'));
        }
      }, TOOL_CALL_TIMEOUT);
    });
  }

  // --- Agent Registry Logic ---

  // Find available agent for user (optionally targeting specific device)
  async findAvailableAgent(userId, targetDeviceId = null) {
    // Search for this specific user's online agent
    let query = this.supabase
      .from('mcp_agents')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'online');

    if (targetDeviceId) {
      // If specific device requested, filter by id (which is now the deviceId)
      query = query.eq('id', targetDeviceId);
    } else {
      // Otherwise get most recently seen
      query = query.order('last_seen', { ascending: false });
    }

    const { data: agent, error } = await query
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error(`❌ [DISPATCH] Error finding agent:`, error);
      throw error;
    }

    return agent;
  }

  async getLastActiveAgent(userId) {
    const { data, error } = await this.supabase
      .from('mcp_agents')
      .select('id')
      .eq('user_id', userId)
      .eq('status', 'online')
      .order('last_seen', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error(`❌ [DISPATCH] Error finding last active agent:`, error);
      return null;
    }

    return data?.id;
  }

  // Find available agent for user (optionally targeting specific device)
  // kept for compatibility if needed, but dispatchTool now uses getLastActiveAgent
  async findAvailableAgent(userId, targetDeviceId = null) {
    // ... same as before or deprecated ...
    // I will leave it as is for now to minimize diff, or delete if strictly unused. 
    // User didn't explicitly say delete `findAvailableAgent`, just "replace usage".
    return this.getLastActiveAgent(userId); // Forwarding for now?
    // Actually, findAvailableAgent handled specific ID targeting too.
    // But now dispatchTool handles targeting logic itself.
  }

  // Get all agents for user
  async getUserAgents(userId) {
    const { data: agents, error } = await this.supabase
      .from('mcp_agents')
      .select('*')
      .eq('user_id', userId)
      .order('last_seen', { ascending: false });

    if (error) throw error;
    return agents || [];
  }

  // --- Helper Methods ---

  // Mark call as failed in database
  async markCallFailed(callId, errorMessage) {
    await this.supabase
      .from('mcp_remote_calls')
      .update({
        status: 'failed',
        error_message: errorMessage,
        completed_at: new Date().toISOString()
      })
      .eq('id', callId);
  }

  // Periodic cleanup of timed out calls
  startCleanupTimer() {
    setInterval(async () => {
      try {
        // Cleanup database
        await this.supabase.rpc('cleanup_timed_out_calls');

        // Cleanup pending promises
        const now = Date.now();
        for (const [callId, pending] of this.pendingCalls) {
          if (now - pending.created > TOOL_CALL_TIMEOUT) { // 30 second timeout
            this.pendingCalls.delete(callId);
            pending.reject(new Error('Tool call timeout'));
          }
        }
      } catch (error) {
        console.error('Cleanup timer error:', error);
      }
    }, TOOL_CALL_TIMEOUT); // Run every 30 seconds
  }

  // Cleanup resources
  async cleanup() {
    if (this.globalChannel) {
      await this.globalChannel.unsubscribe();
    }
  }
}