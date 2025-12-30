# Task 04: Remote Tool Dispatcher

## Objective
Implement the core tool dispatch system that routes tool calls from Claude Desktop to remote agents and returns results.

## Scope
- Create ToolDispatcher class for managing remote tool execution
- Implement agent registry for tracking connected agents
- Create tool call queue with timeout handling
- Handle tool results and error propagation
- Integrate with existing MCP tool registration

## Implementation

### 1. Agent Registry
Create `src/remote/agent-registry.js`:

```javascript
export class AgentRegistry {
  constructor(supabase) {
    this.supabase = supabase;
  }

  // Register or update agent
  async registerAgent(userId, agentName, machineId, capabilities) {
    const { data: agent, error } = await this.supabase
      .from('mcp_agents')
      .upsert({
        user_id: userId,
        agent_name: agentName,
        machine_id: machineId,
        capabilities: capabilities,
        status: 'online',
        last_seen: new Date().toISOString()
      }, {
        onConflict: 'machine_id'
      })
      .select()
      .single();

    if (error) throw error;
    return agent;
  }

  // Update agent status and last seen
  async updateAgentStatus(machineId, status) {
    const { error } = await this.supabase
      .from('mcp_agents')
      .update({ 
        status: status,
        last_seen: new Date().toISOString()
      })
      .eq('machine_id', machineId);

    if (error) throw error;
  }

  // Find available agent for user (currently single agent per user)
  async findAvailableAgent(userId) {
    const { data: agent, error } = await this.supabase
      .from('mcp_agents')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'online')
      .order('last_seen', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    return agent;
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

  // Remove offline agents (cleanup)
  async removeOfflineAgents(olderThanMinutes = 60) {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000).toISOString();
    
    const { error } = await this.supabase
      .from('mcp_agents')
      .delete()
      .eq('status', 'offline')
      .lt('last_seen', cutoff);

    if (error) throw error;
  }
}
```

### 2. Tool Dispatcher
Create `src/remote/tool-dispatcher.js`:

```javascript
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
    // Find available agent for user
    const agent = await this.agentRegistry.findAvailableAgent(userId);
    if (!agent) {
      throw new Error('No agents available - please connect an agent to use remote tools');
    }

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

    if (error) throw error;

    // Broadcast tool call to agent
    await this.channelManager.broadcastToolCall(userId, {
      call_id: remoteCall.id,
      tool_name: toolName,
      args: args
    });

    // Update status to executing
    await this.supabase
      .from('mcp_remote_calls')
      .update({ status: 'executing' })
      .eq('id', remoteCall.id);

    // Return promise that resolves when result received
    return new Promise((resolve, reject) => {
      this.pendingCalls.set(remoteCall.id, { resolve, reject, userId });
      
      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingCalls.has(remoteCall.id)) {
          this.pendingCalls.delete(remoteCall.id);
          this.markCallFailed(remoteCall.id, 'Tool call timeout - agent did not respond');
          reject(new Error('Tool call timeout - agent did not respond'));
        }
      }, 30000);
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
          if (now - pending.created > 30000) { // 30 second timeout
            this.pendingCalls.delete(callId);
            pending.reject(new Error('Tool call timeout'));
          }
        }
      } catch (error) {
        console.error('Cleanup timer error:', error);
      }
    }, 30000); // Run every 30 seconds
  }
}
```

### 3. Integration with MCP Server
Update `src/server/mcp-server.js`:

```javascript
import { AgentRegistry } from '../remote/agent-registry.js';
import { ToolDispatcher } from '../remote/tool-dispatcher.js';

class SupabaseMCPServer {
  constructor() {
    // ... existing setup ...
    
    // Add remote components
    this.agentRegistry = new AgentRegistry(this.supabase);
    this.toolDispatcher = new ToolDispatcher(this.channelManager, this.agentRegistry, this.supabase);
  }

  setupMCPToolHandlers() {
    // Register remote echo tool (stub for testing)
    this.mcpServer.registerTool('remote_echo', {
      description: 'Echo text via remote agent',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to echo' }
        },
        required: ['text']
      }
    }, async (args, extra) => {
      const user = this.getAuthenticatedUser(extra);
      
      // Ensure user has channel subscription
      await this.ensureUserChannel(user.id);
      
      // Dispatch to remote agent
      const result = await this.toolDispatcher.dispatchTool(
        user.id, 
        'echo', // Tool name on agent side
        args
      );
      
      return result;
    });

    // Register agent status tool
    this.mcpServer.registerTool('agent_status', {
      description: 'Get status of connected agents'
    }, async (args, extra) => {
      const user = this.getAuthenticatedUser(extra);
      const agents = await this.agentRegistry.getUserAgents(user.id);
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ 
            agents: agents.map(a => ({
              name: a.agent_name,
              status: a.status,
              last_seen: a.last_seen
            }))
          }, null, 2)
        }]
      };
    });

    // Keep existing tools
    this.setupExistingTools();
  }

  getAuthenticatedUser(extra) {
    const transport = extra.transport || this.mcpTransports.get(extra.sessionId);
    const authContext = transport?._authContext;
    const user = authContext?.user;
    
    if (!user) {
      throw new Error('User authentication required');
    }
    
    return user;
  }
}
```

## Acceptance Criteria
- [ ] AgentRegistry class implemented and working
- [ ] ToolDispatcher class handling remote tool calls
- [ ] Tool call queue with timeout handling (30 seconds)
- [ ] Database integration for call tracking
- [ ] Remote echo tool working as stub
- [ ] Agent status tool showing connected agents
- [ ] Error handling for offline agents
- [ ] Periodic cleanup of timed out calls
- [ ] Integration with existing MCP server
- [ ] No breaking changes to existing functionality

## Dependencies
- Task 01 (Preparation) - for clean codebase
- Task 02 (Database Schema) - for data persistence
- Task 03 (Channel Manager) - for real-time communication

## Estimated Time
4-5 hours