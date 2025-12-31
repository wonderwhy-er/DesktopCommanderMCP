const TOOL_CALL_TIMEOUT = 60000 * 5; // 5 minutes

export class ToolDispatcher {
  constructor(channelManager, agentRegistry, supabase) {
    this.channelManager = channelManager;
    this.agentRegistry = agentRegistry;
    this.supabase = supabase;
    this.pendingCalls = new Map(); // callId -> Promise resolver

    // Setup result handler
    this.channelManager.on('tool_result', this.handleToolResult.bind(this));

    // Setup periodic cleanup
    this.startCleanupTimer();
  }

  // Dispatch tool call to remote agent
  async dispatchTool(userId, toolName, args) {
    console.log(`🚀 [DISPATCH] Starting tool dispatch: ${toolName} for user ${userId}`, { args });

    // Find available agent for user
    const agent = await this.agentRegistry.findAvailableAgent(userId);
    console.log(`🔍 [DISPATCH] Agent lookup result:`, {
      userId,
      foundAgent: !!agent,
      agentId: agent?.id,
      agentStatus: agent?.status
    });

    if (!agent) {
      console.log(`❌ [DISPATCH] No agents available for user ${userId}`);
      throw new Error('No agents available - please connect an agent to use remote tools');
    }

    console.log(`📝 [DISPATCH] Creating remote call record for agent ${agent.id}`);

    // Create remote call record
    const { data: remoteCall, error } = await this.supabase
      .from('mcp_remote_calls')
      .insert({
        user_id: userId,
        agent_id: agent.id,
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

    // Broadcast tool call to agent
    console.log(`📡 [DISPATCH] Broadcasting tool call to user channel: mcp_user_${userId}`);
    try {
      await this.channelManager.broadcastToolCall(userId, {
        call_id: remoteCall.id,
        tool_name: toolName,
        args: args
      });
      console.log(`✅ [DISPATCH] Broadcast successful`);
    } catch (broadcastError) {
      console.error(`❌ [DISPATCH] Broadcast failed:`, broadcastError);
      throw broadcastError;
    }

    // Update status to executing
    console.log(`🔄 [DISPATCH] Updating call status to executing`);
    await this.supabase
      .from('mcp_remote_calls')
      .update({ status: 'executing' })
      .eq('id', remoteCall.id);

    console.log(`⏳ [DISPATCH] Waiting for agent response (30s timeout)`);

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

  // Handle tool result from agent
  async handleToolResult(userId, payload) {
    const { call_id, result, error } = payload;

    const pending = this.pendingCalls.get(call_id);
    if (!pending) {
      console.warn(`Received result for unknown call: ${call_id}`);
      return;
    }

    this.pendingCalls.delete(call_id);

    if (error) {
      await this.markCallFailed(call_id, error);
      pending.reject(new Error(error));
    } else {
      await this.markCallCompleted(call_id, result);
      pending.resolve(result);
    }
  }

  // Mark call as completed in database
  async markCallCompleted(callId, result) {
    await this.supabase
      .from('mcp_remote_calls')
      .update({
        status: 'completed',
        result: result,
        completed_at: new Date().toISOString()
      })
      .eq('id', callId);
  }

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

  // Check if user has any connected agents
  async hasConnectedAgents(userId) {
    const agents = await this.agentRegistry.getUserAgents(userId);
    return agents.some(agent => agent.status === 'online');
  }

  // Get available tools from connected agents
  async getAvailableTools(userId) {
    const agents = await this.agentRegistry.getUserAgents(userId);
    const onlineAgents = agents.filter(agent => agent.status === 'online');

    if (onlineAgents.length === 0) {
      return [];
    }

    // For now, return stub echo tool - will be expanded when agents report capabilities
    return [
      {
        name: 'remote_echo',
        description: 'Echo text via remote agent (stub implementation)',
        inputSchema: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: 'Text to echo back'
            }
          },
          required: ['text']
        }
      }
    ];
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
}