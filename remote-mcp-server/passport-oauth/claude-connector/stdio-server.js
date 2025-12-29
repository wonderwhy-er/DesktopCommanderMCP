#!/usr/bin/env node

/**
 * Claude Desktop MCP Stdio Server with OAuth Authentication
 */

// Load environment variables
import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';
import fetch from 'cross-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

// Import OAuth client
import MCPOAuthClient from './oauth-client.js';

class ClaudeMCPOAuthServer {
  constructor() {
    // OAuth configuration
    this.oauthServerUrl = process.env.OAUTH_BASE_URL || 'http://localhost:4449';
    this.mcpServerUrl = process.env.MCP_BASE_URL || 'http://localhost:3006';
    
    // OAuth client
    this.oauthClient = new MCPOAuthClient({
      oauthServerUrl: this.oauthServerUrl,
      mcpServerUrl: this.mcpServerUrl,
      clientName: 'Claude Desktop MCP OAuth Client',
      scopes: 'openid email profile mcp:tools'
    });
    
    // Authentication state
    this.isAuthenticated = false;
    this.authPromise = null;
    this.availableTools = [];
    
    console.error('[Claude MCP] OAuth Server initializing...');
    console.error(`[Claude MCP] OAuth Server: ${this.oauthServerUrl}`);
    console.error(`[Claude MCP] MCP Server: ${this.mcpServerUrl}`);
  }

  async initialize() {
    // Create MCP server
    this.server = new Server(
      {
        name: 'claude-mcp-oauth',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Register handlers
    this.server.setRequestHandler(ListToolsRequestSchema, this.handleToolsList.bind(this));
    this.server.setRequestHandler(CallToolRequestSchema, this.handleToolCall.bind(this));

    console.error('[Claude MCP] ✅ MCP server initialized');
  }

  async handleToolsList() {
    try {
      console.error('[Claude MCP] Tools list requested');
      
      // Ensure authentication
      await this.ensureAuthenticated();
      
      // Get tools from remote MCP server
      const toolsResponse = await this.oauthClient.getTools();
      this.availableTools = toolsResponse.tools || [];
      
      console.error(`[Claude MCP] Retrieved ${this.availableTools.length} tools from remote server`);
      
      return {
        tools: [
          // Always include authentication tool
          {
            name: 'oauth_authenticate',
            description: 'Authenticate with OAuth server (use if getting auth errors)',
            inputSchema: {
              type: 'object',
              properties: {
                force: {
                  type: 'boolean',
                  description: 'Force re-authentication even if already authenticated',
                  default: false
                }
              },
              required: []
            }
          },
          {
            name: 'oauth_status', 
            description: 'Get current OAuth authentication status',
            inputSchema: {
              type: 'object',
              properties: {},
              required: []
            }
          },
          // Include remote tools
          ...this.availableTools
        ]
      };

    } catch (error) {
      console.error('[Claude MCP] Error getting tools list:', error.message);
      
      // Return minimal toolset if remote unavailable
      return {
        tools: [
          {
            name: 'oauth_authenticate',
            description: 'Authenticate with OAuth server (required for remote tools)',
            inputSchema: {
              type: 'object',
              properties: {
                force: { type: 'boolean', default: false }
              },
              required: []
            }
          },
          {
            name: 'oauth_status',
            description: 'Get OAuth authentication status',
            inputSchema: {
              type: 'object',
              properties: {},
              required: []
            }
          }
        ]
      };
    }
  }

  async handleToolCall(request) {
    const { name, arguments: args } = request.params;
    
    console.error(`[Claude MCP] Tool call: ${name}`);
    
    try {
      // Handle OAuth management tools locally
      if (name === 'oauth_authenticate') {
        return await this.handleOAuthAuthenticate(args);
      }
      
      if (name === 'oauth_status') {
        return await this.handleOAuthStatus();
      }

      // For all other tools, ensure authentication and forward
      await this.ensureAuthenticated();
      
      const result = await this.oauthClient.callTool(name, args);
      
      console.error(`[Claude MCP] Tool call ${name} completed successfully`);
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ]
      };

    } catch (error) {
      console.error(`[Claude MCP] Tool call ${name} failed:`, error.message);
      
      // Check if it's an authentication error
      if (error.message.includes('401') || error.message.includes('unauthorized')) {
        return {
          content: [
            {
              type: 'text',
              text: `❌ Authentication required. Please run the 'oauth_authenticate' tool first.\n\nError: ${error.message}`
            }
          ]
        };
      }
      
      return {
        content: [
          {
            type: 'text',
            text: `❌ Error executing ${name}: ${error.message}\n\nUse 'oauth_status' to check authentication status.`
          }
        ]
      };
    }
  }

  async handleOAuthAuthenticate(args) {
    try {
      const force = args?.force || false;
      
      if (this.isAuthenticated && !force) {
        const status = this.oauthClient.getStatus();
        return {
          content: [
            {
              type: 'text',
              text: `✅ Already authenticated!\n\nClient ID: ${status.client_id}\nToken expires: ${new Date(status.token_expires_at).toISOString()}\n\nUse force=true to re-authenticate.`
            }
          ]
        };
      }

      console.error('[Claude MCP] Starting OAuth authentication...');
      
      await this.oauthClient.authenticate();
      this.isAuthenticated = true;
      
      const status = this.oauthClient.getStatus();
      
      return {
        content: [
          {
            type: 'text',
            text: `🎉 OAuth authentication successful!\n\nClient ID: ${status.client_id}\nOAuth Server: ${status.oauth_server}\nMCP Server: ${status.mcp_server}\nToken expires: ${new Date(status.token_expires_at).toISOString()}\n\nYou can now use remote MCP tools!`
          }
        ]
      };

    } catch (error) {
      console.error('[Claude MCP] OAuth authentication failed:', error.message);
      this.isAuthenticated = false;
      
      return {
        content: [
          {
            type: 'text',
            text: `❌ OAuth authentication failed: ${error.message}\n\nPlease check:\n1. OAuth server is running at ${this.oauthServerUrl}\n2. MCP server is running at ${this.mcpServerUrl}\n3. Network connectivity\n\nTry running 'oauth_status' for more details.`
          }
        ]
      };
    }
  }

  async handleOAuthStatus() {
    try {
      const status = this.oauthClient.getStatus();
      const isConnected = this.oauthClient.isAuthenticated();
      
      let healthCheck = '';
      try {
        // Try to connect to OAuth server
        const oauthHealth = await fetch(`${this.oauthServerUrl}/health`, { timeout: 5000 });
        const mcpHealth = await fetch(`${this.mcpServerUrl}/health`, { timeout: 5000 });
        
        healthCheck = `\nServer Status:\n✅ OAuth Server: ${oauthHealth.ok ? 'Connected' : 'Error'}\n✅ MCP Server: ${mcpHealth.ok ? 'Connected' : 'Error'}`;
      } catch (error) {
        healthCheck = `\nServer Status:\n❌ Connection Error: ${error.message}`;
      }
      
      return {
        content: [
          {
            type: 'text',
            text: `🔐 OAuth Status Report\n\nAuthenticated: ${isConnected ? '✅ Yes' : '❌ No'}\nClient ID: ${status.client_id || 'Not registered'}\nOAuth Server: ${status.oauth_server}\nMCP Server: ${status.mcp_server}\n\nToken Info:\n- Expires: ${status.token_expires_at ? new Date(status.token_expires_at).toISOString() : 'No token'}\n- Time until expiry: ${Math.floor(status.time_until_expiry / 1000)}s\n${healthCheck}\n\n${isConnected ? 'Ready for MCP operations!' : 'Run oauth_authenticate to get started.'}`
          }
        ]
      };

    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `❌ Error getting OAuth status: ${error.message}`
          }
        ]
      };
    }
  }

  async ensureAuthenticated() {
    if (this.isAuthenticated && this.oauthClient.isAuthenticated()) {
      return;
    }

    // If authentication is in progress, wait for it
    if (this.authPromise) {
      await this.authPromise;
      return;
    }

    // If not authenticated, require manual authentication
    if (!this.isAuthenticated) {
      throw new Error('Authentication required. Please run the oauth_authenticate tool first.');
    }

    // Try to refresh token
    try {
      await this.oauthClient.ensureValidToken();
    } catch (error) {
      this.isAuthenticated = false;
      throw new Error('Token refresh failed. Please re-authenticate using oauth_authenticate tool.');
    }
  }

  async start() {
    await this.initialize();
    
    // Create stdio transport
    const transport = new StdioServerTransport();
    
    // Connect to transport
    await this.server.connect(transport);
    
    console.error('[Claude MCP] ✅ Connected to Claude Desktop via stdio');
    console.error('[Claude MCP] 🔐 OAuth authentication required for remote tools');
    console.error('[Claude MCP] 💡 Use oauth_authenticate tool to get started');
    
    return this.server;
  }
}

// Start the server
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new ClaudeMCPOAuthServer();
  
  server.start().catch(error => {
    console.error('❌ Failed to start Claude MCP OAuth server:', error);
    process.exit(1);
  });

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.error('\n🛑 Shutting down Claude MCP OAuth server...');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.error('\n🛑 Shutting down Claude MCP OAuth server...');
    process.exit(0);
  });
}

export default ClaudeMCPOAuthServer;