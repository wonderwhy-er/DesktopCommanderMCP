# Task 05: Agent Implementation

## Objective
Create the remote MCP agent that connects to the base server and executes tools using DesktopCommanderMCP.

## Scope
- Agent authentication with OAuth (desktop + headless)
- Supabase real-time channel subscription
- Tool execution using DesktopCommanderMCP integration
- Agent registration and presence management
- Result propagation back to base server

## Implementation

### 1. Agent Authentication
Create `src/agent/agent-authenticator.js`:

```javascript
import express from 'express';
import { createServer } from 'http';
import open from 'open';
import readline from 'readline';

export class AgentAuthenticator {
  constructor(baseServerUrl) {
    this.baseServerUrl = baseServerUrl;
  }

  async authenticate() {
    // Detect environment
    const isDesktop = this.isDesktopEnvironment();
    
    console.log(`🔐 Starting authentication (${isDesktop ? 'desktop' : 'headless'} mode)...`);
    
    if (isDesktop) {
      return this.authenticateDesktop();
    } else {
      return this.authenticateHeadless();
    }
  }

  isDesktopEnvironment() {
    // Check if we're in a desktop environment
    return process.platform === 'darwin' || 
           process.platform === 'win32' || 
           (process.platform === 'linux' && process.env.DISPLAY);
  }

  async authenticateDesktop() {
    const app = express();
    const callbackPort = 8080;
    const callbackUrl = `http://localhost:${callbackPort}/callback`;
    
    return new Promise((resolve, reject) => {
      let server;
      
      // Setup callback handler
      app.get('/callback', (req, res) => {
        const { access_token, error, error_description } = req.query;
        
        if (error) {
          res.send(`
            <h2>Authentication Failed</h2>
            <p>Error: ${error}</p>
            <p>Description: ${error_description || 'Unknown error'}</p>
            <p>You can close this window.</p>
          `);
          server.close();
          reject(new Error(`${error}: ${error_description}`));
        } else if (access_token) {
          res.send(`
            <h2>Authentication Successful!</h2>
            <p>Your agent is now connected.</p>
            <p>You can close this window.</p>
          `);
          server.close();
          resolve(access_token);
        } else {
          res.send(`
            <h2>Authentication Failed</h2>
            <p>No access token received</p>
            <p>You can close this window.</p>
          `);
          server.close();
          reject(new Error('No access token received'));
        }
      });

      // Start callback server
      server = createServer(app);
      server.listen(callbackPort, (err) => {
        if (err) {
          reject(new Error(`Failed to start callback server: ${err.message}`));
          return;
        }

        // Generate OAuth URL with callback
        const authUrl = `${this.baseServerUrl}/auth.html?redirect_uri=${encodeURIComponent(callbackUrl)}&agent=true`;
        
        console.log('🌐 Opening browser for authentication...');
        console.log(`If browser doesn't open, visit: ${authUrl}`);
        
        // Open browser
        open(authUrl).catch(() => {
          console.log('Could not open browser automatically.');
          console.log(`Please visit: ${authUrl}`);
        });
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        if (server.listening) {
          server.close();
          reject(new Error('Authentication timeout - no response received'));
        }
      }, 5 * 60 * 1000);
    });
  }

  async authenticateHeadless() {
    console.log('\n🔗 Manual Authentication Required:');
    console.log('─'.repeat(50));
    console.log(`1. Open this URL in a browser: ${this.baseServerUrl}/auth.html`);
    console.log('2. Complete the authentication process');
    console.log('3. Copy the access_token from the result');
    console.log('4. Paste it below');
    console.log('─'.repeat(50));

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    return new Promise((resolve, reject) => {
      rl.question('\n🔑 Enter Access Token: ', (token) => {
        rl.close();
        
        const trimmedToken = token.trim();
        if (!trimmedToken) {
          reject(new Error('Empty token provided'));
        } else if (trimmedToken.length < 10) {
          reject(new Error('Invalid token format (too short)'));
        } else {
          resolve(trimmedToken);
        }
      });
    });
  }
}
```

### 2. Desktop Commander Integration
Create `src/agent/desktop-integration.js`:

```javascript
import { spawn } from 'child_process';
import path from 'path';

export class DesktopIntegration {
  constructor() {
    this.mcpServerPath = null;
    this.serverProcess = null;
    this.isReady = false;
  }

  async initialize() {
    // Find DesktopCommanderMCP installation
    this.mcpServerPath = await this.findDesktopCommanderMCP();
    if (!this.mcpServerPath) {
      throw new Error('DesktopCommanderMCP not found. Please install it first.');
    }

    console.log(`Found DesktopCommanderMCP at: ${this.mcpServerPath}`);
  }

  async findDesktopCommanderMCP() {
    // Common installation paths for DesktopCommanderMCP
    const possiblePaths = [
      // If installed globally
      'desktop-commander-mcp',
      // If installed locally
      './node_modules/.bin/desktop-commander-mcp',
      '../desktop-commander-mcp/dist/index.js',
      // Add more paths as needed
    ];

    for (const mcpPath of possiblePaths) {
      try {
        // Test if the MCP server exists and is executable
        const testProcess = spawn('node', [mcpPath, '--version'], { 
          stdio: 'pipe',
          timeout: 5000
        });

        await new Promise((resolve, reject) => {
          testProcess.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Exit code: ${code}`));
          });
          testProcess.on('error', reject);
        });

        return mcpPath;
      } catch (error) {
        // Continue to next path
      }
    }

    return null;
  }

  async executeTool(toolName, args) {
    // For now, implement a simple echo tool as stub
    // Later this will integrate with actual DesktopCommanderMCP
    if (toolName === 'remote_echo') {
      return {
        content: [{
          type: 'text',
          text: args.text || 'No text provided'
        }]
      };
    }

    // Placeholder for other tools
    throw new Error(`Tool ${toolName} not yet implemented in agent`);
  }

  async getCapabilities() {
    // Return available tools - for now just echo
    return {
      tools: [
        {
          name: 'echo',
          description: 'Echo back text',
          inputSchema: {
            type: 'object',
            properties: {
              text: { type: 'string' }
            }
          }
        }
      ]
    };
  }

  async shutdown() {
    if (this.serverProcess) {
      this.serverProcess.kill();
      this.serverProcess = null;
    }
  }
}
```

### 3. Main Agent Implementation
Create `agent.js`:

```javascript
#!/usr/bin/env node

import { createClient } from '@supabase/supabase-js';
import { AgentAuthenticator } from './src/agent/agent-authenticator.js';
import { DesktopIntegration } from './src/agent/desktop-integration.js';
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
    this.user = null;
    
    // Initialize desktop integration
    this.desktop = new DesktopIntegration();
    
    // Graceful shutdown handlers
    process.on('SIGINT', this.shutdown.bind(this));
    process.on('SIGTERM', this.shutdown.bind(this));
  }

  async start() {
    try {
      console.log('🚀 Starting MCP Agent...');
      console.log(`Base Server: ${this.baseServerUrl}`);
      
      // Initialize desktop integration
      await this.desktop.initialize();
      
      // Authenticate with base server
      console.log('\n🔐 Authenticating with base MCP server...');
      const authenticator = new AgentAuthenticator(this.baseServerUrl);
      this.accessToken = await authenticator.authenticate();
      
      // Get Supabase configuration
      console.log('🔧 Configuring Supabase client...');
      const { supabaseUrl, anonKey } = await this.fetchSupabaseConfig();
      this.supabase = createClient(supabaseUrl, anonKey, {
        global: {
          headers: {
            Authorization: `Bearer ${this.accessToken}`
          }
        }
      });

      // Get user info
      const { data: { user }, error: userError } = await this.supabase.auth.getUser();
      if (userError) throw userError;
      this.user = user;

      // Register as agent
      console.log('📝 Registering agent...');
      await this.registerAgent();

      // Subscribe to tool calls
      console.log('🔄 Subscribing to tool call channel...');
      await this.subscribeToToolCalls();

      console.log('✅ Agent ready and listening for tool calls');
      console.log(`Agent ID: ${this.agentId}`);
      console.log(`Machine ID: ${this.machineId}`);
      
      // Keep process alive
      this.startHeartbeat();
      
    } catch (error) {
      console.error('❌ Agent startup failed:', error.message);
      await this.shutdown();
      process.exit(1);
    }
  }

  async fetchSupabaseConfig() {
    const response = await fetch(`${this.baseServerUrl}/api/mcp-info`, {
      headers: {
        'Authorization': `Bearer ${this.accessToken}`
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch Supabase config: ${response.statusText}`);
    }
    
    const config = await response.json();
    return {
      supabaseUrl: config.supabaseUrl,
      anonKey: config.supabaseAnonKey
    };
  }

  async registerAgent() {
    const capabilities = await this.desktop.getCapabilities();
    
    const { data: agent, error } = await this.supabase
      .from('mcp_agents')
      .upsert({
        user_id: this.user.id,
        agent_name: `Agent-${os.hostname()}`,
        machine_id: this.machineId,
        capabilities: capabilities,
        status: 'online',
        last_seen: new Date().toISOString()
      }, {
        onConflict: 'machine_id'
      })
      .select()
      .single();

    if (error) throw error;
    
    this.agentId = agent.id;
    console.log(`✓ Agent registered: ${agent.agent_name}`);
  }

  async subscribeToToolCalls() {
    const channelName = `mcp_user_${this.user.id}`;
    
    this.channel = this.supabase.channel(channelName)
      .on('broadcast', { event: 'tool_call' }, this.handleToolCall.bind(this))
      .subscribe();

    // Track presence
    await this.channel.track({
      agent_id: this.agentId,
      machine_id: this.machineId,
      status: 'online',
      hostname: os.hostname()
    });

    console.log(`✓ Subscribed to channel: ${channelName}`);
  }

  async handleToolCall(payload) {
    const { call_id, tool_name, args } = payload.payload;
    
    console.log(`🔧 Received tool call: ${tool_name} (${call_id})`);
    
    try {
      // Update call status to executing
      await this.supabase
        .from('mcp_remote_calls')
        .update({ status: 'executing' })
        .eq('id', call_id);

      // Execute tool using desktop integration
      const result = await this.desktop.executeTool(tool_name, args);
      
      console.log(`✅ Tool ${tool_name} completed`);

      // Update database with result
      await this.supabase
        .from('mcp_remote_calls')
        .update({
          status: 'completed',
          result: result,
          completed_at: new Date().toISOString()
        })
        .eq('id', call_id);

      // Broadcast result back to base server
      await this.channel.send({
        type: 'broadcast',
        event: 'tool_result',
        payload: {
          call_id: call_id,
          result: result
        }
      });

    } catch (error) {
      console.error(`❌ Tool ${tool_name} failed:`, error.message);
      
      // Update database with error
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

  startHeartbeat() {
    // Update last_seen every 30 seconds
    setInterval(async () => {
      try {
        await this.supabase
          .from('mcp_agents')
          .update({ last_seen: new Date().toISOString() })
          .eq('id', this.agentId);
      } catch (error) {
        console.error('Heartbeat failed:', error.message);
      }
    }, 30000);
  }

  async shutdown() {
    console.log('\n🛑 Shutting down agent...');
    
    try {
      // Unsubscribe from channel
      if (this.channel) {
        await this.channel.unsubscribe();
        console.log('✓ Unsubscribed from channel');
      }
      
      // Mark agent as offline
      if (this.agentId && this.supabase) {
        await this.supabase
          .from('mcp_agents')
          .update({ status: 'offline' })
          .eq('id', this.agentId);
        console.log('✓ Agent marked as offline');
      }
      
      // Shutdown desktop integration
      await this.desktop.shutdown();
      
      console.log('✓ Agent shutdown complete');
    } catch (error) {
      console.error('Shutdown error:', error.message);
    }
  }
}

// Start agent if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const agent = new MCPAgent();
  agent.start();
}

export default MCPAgent;
```

### 4. Package Configuration
Update `package.json` to include agent executable:

```json
{
  "bin": {
    "mcp-agent": "./agent.js"
  },
  "scripts": {
    "agent": "node agent.js",
    "agent:dev": "BASE_MCP_URL=http://localhost:3007 node agent.js"
  }
}
```

## Acceptance Criteria
- [ ] Agent authentication working (desktop + headless modes)
- [ ] Supabase client initialization with auth token
- [ ] Agent registration in database
- [ ] Real-time channel subscription working
- [ ] Tool call handling and execution
- [ ] Result propagation back to base server
- [ ] Presence tracking and heartbeat
- [ ] Graceful shutdown handling
- [ ] Stub echo tool working end-to-end
- [ ] Error handling for failed tool calls

## Dependencies
- Task 01 (Preparation) - for clean codebase
- Task 02 (Database Schema) - for agent storage
- Task 03 (Channel Manager) - for real-time communication
- Task 04 (Tool Dispatcher) - for tool call handling

## Estimated Time
5-6 hours