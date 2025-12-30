# Remote MCP Proxy Implementation Plan

## Overview
Transform the current Supabase MCP server into a remote MCP proxy that manages client-mcp agents running on remote machines. The base-mcp (server) will authenticate users and proxy tool calls to client-mcp agents via Supabase real-time channels.

## Architecture Analysis

### Current State
- **Base MCP Server**: OAuth-authenticated HTTP server with MCP SDK integration
- **Tool Registry**: Modular tools (echo, user_info, supabase_query)
- **Authentication**: OAuth 2.0 + PKCE flow with Supabase JWT validation
- **Session Management**: Per-user transport instances with authentication context
- **Database**: mcp_sessions, mcp_tool_calls tables with RLS

### Target Architecture
```
Claude Desktop → HTTP Connector → Base MCP Server → Supabase Channels → Client MCP Agent → DesktopCommanderMCP
     ↑                                    ↓                                           ↓
     └─────────────────── Tool Results ←──────────────────────────────────────────────┘
```

## Requirements Analysis

### Core Features
1. **Base MCP Server**: Accept auth from Claude Desktop clients
2. **Remote Agent Management**: Manage multiple client-mcp agents per user
3. **Real-time Communication**: Bidirectional tool call proxy via Supabase channels
4. **Agent Authentication**: OAuth flow for agent registration with desktop/headless support
5. **Tool Call Routing**: Proxy tool calls from Claude Desktop to appropriate agent
6. **Result Propagation**: Return agent results back to Claude Desktop

### Technical Requirements
- **Minimal LoC**: Remove redundancy, focus on essential components
- **Low Complexity**: Decompose complex functions, single responsibility
- **Real-time**: Supabase channels for immediate tool call dispatch
- **Authentication**: OAuth for agents with desktop browser + headless support

## Code Refactoring Plan

### 1. Remove Redundant Components
**Keep:**
```javascript
// Keep OAuth discovery endpoints
- /.well-known/oauth-protected-resource (lines 403-425)
```
**Delete/Simplify:**
```javascript

// Simplify PKCE to use Supabase instead of memory
- pkceCodes Map (line 50) → supabase storage

// Remove duplicate endpoints
- /mcp-direct route → merge with /mcp

// Remove unused SSE references
- test-complete-flow.js SSE connector references
```

### 2. Decompose High Complexity Functions

**Extract OAuth handling:**
```javascript
// Current: 100+ line authorization handler
src/server/mcp-server.js:428-540

// New: Separate classes
src/auth/oauth-validator.js     # Parameter validation
src/auth/oauth-processor.js     # PKCE processing  
src/auth/oauth-responder.js     # Redirect handling
```

**Extract Session Management:**
```javascript
// Current: Complex transport management
src/server/mcp-server.js:191-224

// New: Dedicated manager
src/session/session-manager.js  # User session coordination
src/session/transport-factory.js # Transport creation
```

### 3. Add Remote MCP Components

**New Core Components:**
```javascript
src/remote/
├── channel-manager.js          # Supabase real-time channels
├── agent-registry.js           # Track connected agents
├── tool-dispatcher.js          # Route tool calls to agents  
├── result-collector.js         # Collect and return results
└── agent-authenticator.js      # Agent OAuth flow
```

## Implementation Plan

### Phase 1: Core Infrastructure (Day 1)

#### 1.1 Supabase Schema Updates
```sql
-- Agent registration and management
CREATE TABLE mcp_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  machine_id TEXT UNIQUE NOT NULL,
  capabilities JSONB DEFAULT '{}',
  status TEXT DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'connecting')),
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  auth_token TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tool call queue for remote execution
CREATE TABLE mcp_remote_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES mcp_agents(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  tool_args JSONB DEFAULT '{}',
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'executing', 'completed', 'failed')),
  result JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Enable RLS
ALTER TABLE mcp_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_remote_calls ENABLE ROW LEVEL SECURITY;

-- RLS policies
CREATE POLICY "Users see own agents" ON mcp_agents FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Users see own remote calls" ON mcp_remote_calls FOR ALL USING (auth.uid() = user_id);
```

#### 1.2 Channel Manager Implementation
```javascript
// src/remote/channel-manager.js
export class ChannelManager {
  constructor(supabase) {
    this.supabase = supabase;
    this.channels = new Map(); // userId -> channel
  }

  async subscribeToUser(userId) {
    const channelName = `mcp_user_${userId}`;
    
    const channel = this.supabase.channel(channelName)
      .on('broadcast', { event: 'tool_call' }, this.handleToolCall.bind(this))
      .on('broadcast', { event: 'tool_result' }, this.handleToolResult.bind(this))
      .on('presence', { event: 'sync' }, this.handleAgentPresence.bind(this))
      .subscribe();

    this.channels.set(userId, channel);
    return channel;
  }

  async broadcastToolCall(userId, toolCall) {
    const channel = this.channels.get(userId);
    return channel?.send({
      type: 'broadcast',
      event: 'tool_call',
      payload: toolCall
    });
  }

  async broadcastToolResult(userId, result) {
    const channel = this.channels.get(userId);
    return channel?.send({
      type: 'broadcast', 
      event: 'tool_result',
      payload: result
    });
  }
}
```

### Phase 2: Remote Tool Dispatch (Day 2)

#### 2.1 Tool Dispatcher
```javascript
// src/remote/tool-dispatcher.js
export class ToolDispatcher {
  constructor(channelManager, supabase) {
    this.channelManager = channelManager;
    this.supabase = supabase;
    this.pendingCalls = new Map(); // callId -> Promise resolver
  }

  async dispatchTool(userId, toolName, args) {
    // Find available agent for user
    const agent = await this.findAvailableAgent(userId);
    if (!agent) {
      throw new Error('No agents available for user');
    }

    // Create remote call record
    const { data: remoteCall } = await this.supabase
      .from('mcp_remote_calls')
      .insert({
        user_id: userId,
        agent_id: agent.id,
        tool_name: toolName,
        tool_args: args
      })
      .select()
      .single();

    // Broadcast to agent
    await this.channelManager.broadcastToolCall(userId, {
      call_id: remoteCall.id,
      tool_name: toolName,
      args: args
    });

    // Return promise that resolves when result received
    return new Promise((resolve, reject) => {
      this.pendingCalls.set(remoteCall.id, { resolve, reject });
      
      // Timeout after 30 seconds
      setTimeout(() => {
        this.pendingCalls.delete(remoteCall.id);
        reject(new Error('Tool call timeout'));
      }, 30000);
    });
  }

  handleToolResult(callId, result, error) {
    const pending = this.pendingCalls.get(callId);
    if (pending) {
      this.pendingCalls.delete(callId);
      if (error) {
        pending.reject(new Error(error));
      } else {
        pending.resolve(result);
      }
    }
  }
}
```

#### 2.2 Agent Registry
```javascript
// src/remote/agent-registry.js
export class AgentRegistry {
  constructor(supabase) {
    this.supabase = supabase;
  }

  async registerAgent(userId, agentName, machineId, capabilities) {
    const { data: agent } = await this.supabase
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

    return agent;
  }

  async updateAgentStatus(machineId, status) {
    await this.supabase
      .from('mcp_agents')
      .update({ 
        status: status,
        last_seen: new Date().toISOString()
      })
      .eq('machine_id', machineId);
  }

  async findAvailableAgent(userId) {
    const { data: agent } = await this.supabase
      .from('mcp_agents')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'online')
      .order('last_seen', { ascending: false })
      .limit(1)
      .single();

    return agent;
  }
}
```

### Phase 3: Agent Implementation (Day 3)

#### 3.1 Agent OAuth Flow
```javascript
// src/agent/agent-authenticator.js
import express from 'express';
import open from 'open';

export class AgentAuthenticator {
  constructor(baseServerUrl) {
    this.baseServerUrl = baseServerUrl;
    this.app = express();
  }

  async authenticate() {
    // Check environment
    const isDesktop = process.platform !== 'linux' || process.env.DISPLAY;
    
    if (isDesktop) {
      return this.authenticateDesktop();
    } else {
      return this.authenticateHeadless();
    }
  }

  async authenticateDesktop() {
    // Start local callback server
    const callbackPort = 8080;
    const callbackUrl = `http://localhost:${callbackPort}/callback`;
    
    return new Promise((resolve, reject) => {
      // Setup callback handler
      this.app.get('/callback', (req, res) => {
        const { access_token, error } = req.query;
        
        if (error) {
          res.send('Authentication failed. You can close this window.');
          reject(new Error(error));
        } else {
          res.send('Authentication successful! You can close this window.');
          resolve(access_token);
          server.close();
        }
      });

      const server = this.app.listen(callbackPort, () => {
        // Generate OAuth URL
        const authUrl = `${this.baseServerUrl}/auth.html?redirect_uri=${encodeURIComponent(callbackUrl)}`;
        
        console.log('Opening browser for authentication...');
        open(authUrl);
      });
    });
  }

  async authenticateHeadless() {
    console.log('\nTo authenticate this agent:');
    console.log(`1. Open: ${this.baseServerUrl}/auth.html`);
    console.log('2. Complete authentication');
    console.log('3. Copy the access token from the result');
    console.log('4. Paste it below:\n');

    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    return new Promise((resolve) => {
      rl.question('Access Token: ', (token) => {
        rl.close();
        resolve(token.trim());
      });
    });
  }
}
```

#### 3.2 Agent Main Implementation
```javascript
// agent.js - Main agent file
import { createClient } from '@supabase/supabase-js';
import { DesktopCommanderMCP } from 'desktop-commander-mcp'; // Hypothetical import
import { AgentAuthenticator } from './src/agent/agent-authenticator.js';
import { randomUUID } from 'crypto';
import os from 'os';

class MCPAgent {
  constructor() {
    this.baseServerUrl = process.env.BASE_MCP_URL || 'http://localhost:3007';
    this.supabase = null;
    this.accessToken = null;
    this.agentId = null;
    this.machineId = `${os.hostname()}-${randomUUID()}`;
    this.channel = null;
    
    // Initialize DesktopCommanderMCP
    this.desktopCommander = new DesktopCommanderMCP();
  }

  async start() {
    try {
      // Authenticate with base server
      console.log('🔐 Authenticating with base MCP server...');
      const authenticator = new AgentAuthenticator(this.baseServerUrl);
      this.accessToken = await authenticator.authenticate();
      
      // Initialize Supabase client
      const { supabaseUrl, anonKey } = await this.fetchSupabaseConfig();
      this.supabase = createClient(supabaseUrl, anonKey, {
        global: {
          headers: {
            Authorization: `Bearer ${this.accessToken}`
          }
        }
      });

      // Register as agent
      console.log('📝 Registering agent...');
      await this.registerAgent();

      // Subscribe to tool calls
      console.log('🔄 Listening for tool calls...');
      await this.subscribeToToolCalls();

      console.log('✅ Agent ready and listening for tool calls');
    } catch (error) {
      console.error('❌ Agent startup failed:', error.message);
      process.exit(1);
    }
  }

  async registerAgent() {
    const capabilities = await this.desktopCommander.getCapabilities();
    
    const { data: agent, error } = await this.supabase
      .from('mcp_agents')
      .upsert({
        agent_name: `Agent-${os.hostname()}`,
        machine_id: this.machineId,
        capabilities: capabilities,
        status: 'online'
      }, {
        onConflict: 'machine_id'
      })
      .select()
      .single();

    if (error) throw error;
    
    this.agentId = agent.id;
    console.log(`Agent registered with ID: ${this.agentId}`);
  }

  async subscribeToToolCalls() {
    // Get user ID from token
    const { data: { user } } = await this.supabase.auth.getUser();
    const userId = user.id;

    // Subscribe to user channel
    this.channel = this.supabase.channel(`mcp_user_${userId}`)
      .on('broadcast', { event: 'tool_call' }, this.handleToolCall.bind(this))
      .on('presence', { event: 'sync' }, this.handlePresence.bind(this))
      .subscribe();

    // Track presence
    await this.channel.track({
      agent_id: this.agentId,
      machine_id: this.machineId,
      status: 'online'
    });
  }

  async handleToolCall(payload) {
    const { call_id, tool_name, args } = payload;
    
    console.log(`🔧 Executing tool: ${tool_name}`);
    
    try {
      // Execute tool using DesktopCommanderMCP
      const result = await this.desktopCommander.executeTool(tool_name, args);
      
      // Update call status
      await this.supabase
        .from('mcp_remote_calls')
        .update({
          status: 'completed',
          result: result,
          completed_at: new Date().toISOString()
        })
        .eq('id', call_id);

      // Broadcast result back
      await this.channel.send({
        type: 'broadcast',
        event: 'tool_result',
        payload: {
          call_id: call_id,
          result: result
        }
      });

      console.log(`✅ Tool ${tool_name} completed successfully`);
    } catch (error) {
      console.error(`❌ Tool ${tool_name} failed:`, error.message);
      
      // Update call with error
      await this.supabase
        .from('mcp_remote_calls')
        .update({
          status: 'failed',
          error_message: error.message,
          completed_at: new Date().toISOString()
        })
        .eq('id', call_id);

      // Broadcast error back
      await this.channel.send({
        type: 'broadcast',
        event: 'tool_result',
        payload: {
          call_id: call_id,
          error: error.message
        }
      });
    }
  }

  async fetchSupabaseConfig() {
    const response = await fetch(`${this.baseServerUrl}/api/mcp-info`);
    const config = await response.json();
    return {
      supabaseUrl: config.supabaseUrl,
      anonKey: config.supabaseAnonKey
    };
  }

  async shutdown() {
    if (this.channel) {
      await this.channel.unsubscribe();
    }
    
    if (this.agentId) {
      await this.supabase
        .from('mcp_agents')
        .update({ status: 'offline' })
        .eq('id', this.agentId);
    }
    
    console.log('Agent shutdown complete');
  }
}

// Start agent
const agent = new MCPAgent();
agent.start();

// Graceful shutdown
process.on('SIGINT', () => agent.shutdown().then(() => process.exit(0)));
process.on('SIGTERM', () => agent.shutdown().then(() => process.exit(0)));
```

### Phase 4: Base Server Integration (Day 4)

#### 4.1 Update Main Server
```javascript
// src/server/mcp-server.js - Key modifications

class SupabaseMCPServer {
  constructor() {
    // ... existing setup ...
    
    // Add remote components
    this.channelManager = new ChannelManager(this.supabase);
    this.agentRegistry = new AgentRegistry(this.supabase);
    this.toolDispatcher = new ToolDispatcher(this.channelManager, this.supabase);
  }

  setupMCPToolHandlers() {
    // Get all available tools from agents instead of local tools
    this.mcpServer.registerTool('get_available_tools', {
      description: 'Get tools available from connected agents'
    }, async (args, extra) => {
      const user = this.getAuthenticatedUser(extra);
      const agents = await this.agentRegistry.getUserAgents(user.id);
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ agents })
        }]
      };
    });

    // Dynamic tool registration for agent tools
    this.mcpServer.registerTool('execute_remote_tool', {
      description: 'Execute a tool on a remote agent',
      inputSchema: {
        type: 'object',
        properties: {
          tool_name: { type: 'string' },
          args: { type: 'object' }
        }
      }
    }, async (args, extra) => {
      const user = this.getAuthenticatedUser(extra);
      const result = await this.toolDispatcher.dispatchTool(
        user.id, 
        args.tool_name, 
        args.args
      );
      
      return result;
    });
  }
}
```

## File Structure After Refactoring

```
supabase-mcp/
├── src/
│   ├── server/
│   │   ├── mcp-server.js           # Simplified main server
│   │   ├── auth-middleware.js      # Simplified auth
│   │   └── tools/                  # Local tools only
│   ├── remote/
│   │   ├── channel-manager.js      # Supabase channels
│   │   ├── agent-registry.js       # Agent tracking
│   │   ├── tool-dispatcher.js      # Tool routing
│   │   └── result-collector.js     # Result handling
│   ├── agent/
│   │   ├── agent-authenticator.js  # Agent OAuth
│   │   └── desktop-integration.js  # DesktopCommanderMCP wrapper
│   ├── auth/
│   │   ├── oauth-validator.js      # OAuth validation
│   │   ├── oauth-processor.js      # OAuth processing
│   │   └── pkce-handler.js         # PKCE operations
│   ├── session/
│   │   ├── session-manager.js      # Session coordination
│   │   └── transport-factory.js    # Transport creation
│   └── utils/                      # Existing utilities
├── agent.js                        # Main agent executable
├── migrations/                     # Database migrations
└── tests/
```

## Key Benefits

1. **Minimal LoC**: Remove ~40% of current code complexity
2. **Low Complexity**: Single responsibility classes, max 50 lines per function
3. **Real-time**: Instant tool dispatch via Supabase channels
4. **Scalable**: Multiple agents per user, multiple users per server
5. **Secure**: RLS-based isolation, OAuth authentication for agents

## Discussion Points

### 1. Agent Discovery
**Question**: How should the base server discover available tools on agents?
**TODO**: at the moment implement STUB echo method to test remote calls, will clarify this later
**Options**: 
- A) Agent broadcasts capabilities on connect
- B) Base server queries agent capabilities on demand
- C) Hybrid: Cache capabilities, refresh periodically

### 2. Tool Call Routing
**Question**: How to handle multiple agents with same tool?
**TODO**: at the moment only one agent per user will be supported
**Options**:
- A) Round-robin distribution
- B) Agent preference/priority system  
- C) User-defined routing rules

### 3. Failure Handling
**Question**: What happens when an agent goes offline mid-execution?
**TODO**: Use C) - return error immediately
**Options**:
- A) Queue tool calls until agent reconnects
- B) Route to different agent if available
- C) Return error immediately

### 4. Authentication Token Management
**Question**: How to handle token refresh for agents?
**TODO**: Use B) Refresh token flow for agents
**Options**:
- A) Long-lived tokens (security risk)
- B) Refresh token flow for agents
- C) Re-authentication on expiry

Please review this plan and let me know:
1. Which discussion points need clarification?
2. Any aspects of the architecture you want to modify?
3. Timeline and implementation priority preferences?