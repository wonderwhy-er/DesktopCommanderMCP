#!/usr/bin/env node

import { createClient } from '@supabase/supabase-js';
import { AgentAuthenticator } from './src/agent/agent-authenticator.js';
import { DesktopIntegration } from './src/agent/desktop-integration.js';
import { randomUUID } from 'crypto';
import os from 'os';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';

// Load environment variables from .env file
dotenv.config();

class MCPAgent {
  constructor() {
    this.baseServerUrl = process.env.MCP_SERVER_URL || 'http://localhost:3007';
    this.supabase = null;
    this.accessToken = null;
    this.agentId = null;
    this.machineId = null; // Will be loaded or generated
    this.channel = null;
    this.user = null;
    this.isShuttingDown = false;
    this.configPath = path.join(process.cwd(), 'agent.json');

    // Initialize desktop integration
    this.desktop = new DesktopIntegration();

    // Graceful shutdown handlers (only set once)
    this.setupShutdownHandlers();
  }

  setupShutdownHandlers() {
    const handleShutdown = async (signal) => {
      if (this.isShuttingDown) {
        console.log(`\n${signal} received, but already shutting down...`);
        return;
      }

      console.log(`\n${signal} received, initiating graceful shutdown...`);
      await this.shutdown();
      process.exit(0);
    };

    process.on('SIGINT', () => handleShutdown('SIGINT'));
    process.on('SIGTERM', () => handleShutdown('SIGTERM'));

    // Handle uncaught exceptions
    process.on('uncaughtException', async (error) => {
      console.error('Uncaught exception:', error);
      await this.shutdown();
      process.exit(1);
    });

    process.on('unhandledRejection', async (reason, promise) => {
      console.error('Unhandled rejection at:', promise, 'reason:', reason);
      await this.shutdown();
      process.exit(1);
    });
  }

  async start() {
    try {
      console.log('🚀 Starting MCP Agent...');
      console.log(`Base Server: ${this.baseServerUrl}`);

      if (process.env.DEBUG_MODE === 'true') {
        console.log('🔍 Environment variables loaded:');
        console.log(`  - MCP_SERVER_URL: ${process.env.MCP_SERVER_URL || 'not set'}`);
        console.log(`  - DEBUG_MODE: ${process.env.DEBUG_MODE || 'not set'}`);
      }

      // Initialize desktop integration
      await this.desktop.initialize();

      // Load persisted configuration (machineId, accessToken)
      await this.loadPersistedConfig();

      // Ensure machineId exists
      if (!this.machineId) {
        this.machineId = `${os.hostname()}-${randomUUID()}`;
        await this.savePersistedConfig();
      }

      let isAuthenticated = false;

      // Try to use persisted token
      if (this.accessToken) {
        console.log('💾 Found persisted access token, verifying...');
        try {
          // Verify token by fetching config
          const config = await this.fetchSupabaseConfig(true); // silent mode
          // If successful, we are authenticated
          console.log('✅ Persisted token is valid');

          this.supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
            global: {
              headers: {
                Authorization: `Bearer ${this.accessToken}`
              }
            }
          });

          isAuthenticated = true;
        } catch (error) {
          console.log('⚠️ Persisted token invalid or expired:', error.message);
          this.accessToken = null;
        }
      }

      // Authenticate if needed
      if (!isAuthenticated) {
        console.log('\n🔐 Authenticating with base MCP server...');
        const authenticator = new AgentAuthenticator(this.baseServerUrl);
        this.accessToken = await authenticator.authenticate();

        // Save new token
        await this.savePersistedConfig();

        // Get Supabase config
        console.log('🔧 Configuring Supabase client...');
        const config = await this.fetchSupabaseConfig();
        this.supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
          global: {
            headers: {
              Authorization: `Bearer ${this.accessToken}`
            }
          }
        });
      }

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
      if (error.stack && process.env.DEBUG_MODE === 'true') {
        console.error('Stack trace:', error.stack);
      }
      await this.shutdown();
      process.exit(1);
    }
  }

  async loadPersistedConfig() {
    try {
      const data = await fs.readFile(this.configPath, 'utf8');
      const config = JSON.parse(data);

      if (config.machineId) this.machineId = config.machineId;
      if (config.accessToken) this.accessToken = config.accessToken;

      console.log('📂 Loaded persisted configuration');
    } catch (error) {
      // Ignore missing file
      if (error.code !== 'ENOENT') {
        console.warn('⚠️ Failed to load config:', error.message);
      }
    }
  }

  async savePersistedConfig() {
    try {
      const config = {
        machineId: this.machineId,
        accessToken: this.accessToken
      };

      // Save with secure permissions (600 - read/write only by owner)
      await fs.writeFile(this.configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
      console.log('💾 Configuration saved to agent.json');
    } catch (error) {
      console.error('❌ Failed to save config:', error.message);
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
    if (this.isShuttingDown) {
      return;
    }

    this.isShuttingDown = true;
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