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

const HEARTBEAT_INTERVAL = 30000;

class MCPAgent {
  constructor() {
    this.baseServerUrl = process.env.MCP_SERVER_URL || 'http://localhost:3007';
    this.supabase = null;
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
        console.log(`  - DEBUG_MODE: ${process.env.DEBUG_MODE || 'not set'}`);
      }

      // Initialize desktop integration
      await this.desktop.initialize();

      // Load persisted configuration (machineId, session)
      let session = await this.loadPersistedConfig();

      console.log('🔧 Setting up Supabase client...');
      const { supabaseUrl, anonKey } = await this.fetchSupabaseConfig();

      // Initialize Supabase Client
      this.supabase = createClient(supabaseUrl, anonKey);

      // 2. Set Session or Authenticate
      if (session) {
        console.log('💾 Found persisted session, restoring...');
        const { data, error } = await this.supabase.auth.setSession({
          access_token: session.access_token,
          refresh_token: session.refresh_token
        });

        if (error) {
          console.log('⚠️ Persisted session invalid:', error.message);
          session = null;
        } else {
          console.log('✅ Session restored');
        }
      }

      if (!session) {
        console.log('\n🔐 Authenticating with base MCP server...');
        const authenticator = new AgentAuthenticator(this.baseServerUrl);
        // Authenticator now returns { access_token, refresh_token }
        session = await authenticator.authenticate();

        console.log('✅ Authentication successful');

        // Set session in Supabase
        const { data, error } = await this.supabase.auth.setSession({
          access_token: session.access_token,
          refresh_token: session.refresh_token
        });

        if (error) throw error;
      }

      // 3. Setup Token Refresh Listener
      this.supabase.auth.onAuthStateChange(async (event, newSession) => {
        if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
          if (newSession) {
            console.log(`🔄 Auth state change: ${event}`);
            await this.savePersistedConfig(newSession);
          }
        } else if (event === 'SIGNED_OUT') {
          console.log('⚠️ User signed out');
          // Handle sign out?
        }
      });

      // Force save the current session immediately to ensure it's persisted
      // (in case onAuthStateChange doesn't fire immediately for setSession)
      await this.savePersistedConfig(
        (await this.supabase.auth.getSession()).data.session
      );

      // Get user info
      const { data: { user }, error: userError } = await this.supabase.auth.getUser();
      if (userError) throw userError;
      this.user = user;

      // Register as agent
      console.log('📝 Registering agent...');
      await this.registerAgent();

      // Subscribe to tool calls
      console.log('🔄 Subscribing to job queue...');
      await this.subscribeToToolCallQueue();

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

  async ensureMachineId() {
    if (!this.machineId) {
      this.machineId = `${os.hostname()}-${randomUUID()}`;
      await this.savePersistedConfig(null); // Save just machineId
    }
  }

  async loadPersistedConfig() {
    try {
      const data = await fs.readFile(this.configPath, 'utf8');
      const config = JSON.parse(data);

      if (config.session) {
        return config.session;
      }

      return null;
    } catch (error) {

      if (error.code !== 'ENOENT') {
        console.warn('⚠️ Failed to load config:', error.message);
      }
      return null;
    } finally {
      await this.ensureMachineId();
    }
  }

  async savePersistedConfig(session) {
    try {
      const config = {
        machineId: this.machineId,
        session: session ? {
          access_token: session.access_token,
          refresh_token: session.refresh_token
        } : null
      };

      await fs.writeFile(this.configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
      if (session) console.log('💾 Session saved to agent.json');
    } catch (error) {
      console.error('❌ Failed to save config:', error.message);
    }
  }

  async fetchSupabaseConfig() {
    // No auth header needed for this public endpoint
    const response = await fetch(`${this.baseServerUrl}/api/mcp-info`);

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

    console.log(`🔍 Checking for existing agent (User: ${this.user.id}, Machine: ${this.machineId})...`);

    // 1. Try to find existing agent
    const { data: existingAgent, error: findError } = await this.supabase
      .from('mcp_agents')
      .select('id, agent_name')
      .eq('user_id', this.user.id)
      .eq('machine_id', this.machineId)
      .maybeSingle();

    if (findError) throw findError;

    if (existingAgent) {
      console.log(`✅ Found existing agent: ${existingAgent.agent_name} (${existingAgent.id})`);

      this.agentId = existingAgent.id;

      // 2. Update status and capabilities
      await this.supabase
        .from('mcp_agents')
        .update({
          status: 'online',
          last_seen: new Date().toISOString(),
          capabilities: capabilities,
          agent_name: `Agent-${os.hostname()}` // Update name in case hostname changed
        })
        .eq('id', this.agentId);

    } else {
      console.log('📝 No existing agent found, creating new registration...');

      // 3. Create new agent
      const { data: newAgent, error: createError } = await this.supabase
        .from('mcp_agents')
        .insert({
          user_id: this.user.id,
          agent_name: `Agent-${os.hostname()}`,
          machine_id: this.machineId,
          capabilities: capabilities,
          status: 'online',
          last_seen: new Date().toISOString()
        })
        .select()
        .single();

      if (createError) throw createError;

      this.agentId = newAgent.id;
      console.log(`✓ Agent registered: ${newAgent.agent_name}`);
    }
  }

  async subscribeToToolCallQueue() {
    console.log(` Subscribing to job queue for user: ${this.user.id}`);

    this.channel = this.supabase.channel('agent_tool_call_queue')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'mcp_remote_calls',
          filter: `user_id=eq.${this.user.id}`
        },
        (payload) => this.handleNewToolCall(payload)
      )
      .subscribe((status) => {
        console.log(`Subscription status: ${status}`);
        if (status === 'SUBSCRIBED') {
          console.log('✅ Connected to tool call queue');
        }
      });
  }

  async handleNewToolCall(payload) {
    const toolCall = payload.new;
    const { id: call_id, tool_name, tool_args, agent_id } = toolCall;

    // Only process jobs for this agent
    if (agent_id && agent_id !== this.agentId) {
      return;
    }

    console.log(`🔧 Received tool call: ${tool_name} (${call_id})`);

    try {
      // Update call status to executing
      await this.supabase
        .from('mcp_remote_calls')
        .update({ status: 'executing' })
        .eq('id', call_id);

      let result;

      // Handle 'ping' tool specially
      if (tool_name === 'ping') {
        result = {
          content: [{
            type: 'text',
            text: `pong ${new Date().toISOString()}`
          }]
        };
      } else {
        // Execute other tools using desktop integration
        result = await this.desktop.executeTool(tool_name, tool_args);
      }

      console.log(`✅ Tool call ${tool_name} completed`);

      // Update database with result
      await this.updateToolCallResult(call_id, 'completed', result);

    } catch (error) {
      console.error(`❌ Tool call ${tool_name} failed:`, error.message);
      await this.updateToolCallResult(call_id, 'failed', null, error.message);
    }
  }

  async updateToolCallResult(callId, status, result = null, errorMessage = null) {
    const updateData = {
      status: status,
      completed_at: new Date().toISOString()
    };

    if (result !== null) updateData.result = result;
    if (errorMessage !== null) updateData.error_message = errorMessage;

    await this.supabase
      .from('mcp_remote_calls')
      .update(updateData)
      .eq('id', callId);
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
    }, HEARTBEAT_INTERVAL);
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