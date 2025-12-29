#!/usr/bin/env node

/**
 * Simple MCP Server with stdio transport and OAuth authentication
 * For use with Claude Desktop's mcp_config.json - performs OAuth on startup
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { 
  CallToolRequestSchema, 
  ListToolsRequestSchema 
} from '@modelcontextprotocol/sdk/types.js';
import crypto from 'crypto';
import http from 'http';
import { exec } from 'child_process';

/**
 * OAuth Client for MCP Server
 */
class MCPOAuthClient {
  constructor(options = {}) {
    this.oauthServerUrl = options.oauthServerUrl || process.env.OAUTH_BASE_URL || 'http://localhost:4449';
    this.clientName = options.clientName || 'Simple MCP OAuth Client';
    this.callbackPort = options.callbackPort || 8848; // Different port to avoid conflicts
    this.scopes = options.scopes || 'openid email profile mcp:tools';
    
    this.clientInfo = null;
    this.accessToken = null;
    this.refreshToken = null;
    this.tokenExpiry = null;
    
    console.error(`[MCP OAuth] OAuth Client initialized for: ${this.oauthServerUrl}`);
  }

  /**
   * Perform complete OAuth flow
   */
  async authenticate() {
    try {
      console.error('[MCP OAuth] 🔐 Starting OAuth authentication flow...');
      
      // 1. Register OAuth client
      this.clientInfo = await this.registerClient();
      console.error(`[MCP OAuth] ✅ Client registered: ${this.clientInfo.client_id}`);
      
      // 2. Generate PKCE parameters
      const pkceParams = this.generatePKCE();
      console.error('[MCP OAuth] 🔑 PKCE parameters generated');
      
      // 3. Get authorization code
      const authCode = await this.getAuthorizationCode(pkceParams);
      console.error('[MCP OAuth] 📝 Authorization code obtained');
      
      // 4. Exchange code for tokens
      const tokens = await this.exchangeCodeForTokens(authCode, pkceParams);
      
      this.accessToken = tokens.access_token;
      this.refreshToken = tokens.refresh_token;
      this.tokenExpiry = Date.now() + (tokens.expires_in * 1000);
      
      console.error('[MCP OAuth] 🎉 OAuth authentication completed successfully!');
      console.error(`[MCP OAuth] 🎫 Access token: ${this.accessToken.substring(0, 20)}...`);
      return true;
      
    } catch (error) {
      console.error('[MCP OAuth] ❌ OAuth authentication failed:', error.message);
      throw error;
    }
  }

  /**
   * Register OAuth client dynamically
   */
  async registerClient() {
    const registrationData = {
      client_name: this.clientName,
      redirect_uris: [`http://localhost:${this.callbackPort}/callback`],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: this.scopes
    };

    const fetch = (await import('node-fetch')).default;
    const response = await fetch(`${this.oauthServerUrl}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(registrationData)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Client registration failed: ${response.status} - ${error}`);
    }

    return await response.json();
  }

  /**
   * Generate PKCE parameters
   */
  generatePKCE() {
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');

    return {
      code_verifier: codeVerifier,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state: state
    };
  }

  /**
   * Get authorization code via local callback server
   */
  async getAuthorizationCode(pkceParams) {
    return new Promise((resolve, reject) => {
      // Create temporary HTTP server to receive callback
      const server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://localhost:${this.callbackPort}`);
        
        if (url.pathname === '/callback') {
          const code = url.searchParams.get('code');
          const state = url.searchParams.get('state');
          const error = url.searchParams.get('error');
          
          // Send response to browser
          res.writeHead(200, { 'Content-Type': 'text/html' });
          if (error) {
            res.end(`<html><body><h1>OAuth Error</h1><p>Error: ${error}</p><p>You can close this window.</p></body></html>`);
            server.close();
            reject(new Error(`OAuth error: ${error}`));
          } else if (code && state === pkceParams.state) {
            res.end(`<html><body><h1>OAuth Success!</h1><p>Authorization code received. You can close this window.</p></body></html>`);
            server.close();
            resolve(code);
          } else {
            res.end(`<html><body><h1>OAuth Error</h1><p>Invalid callback parameters</p></body></html>`);
            server.close();
            reject(new Error('Invalid callback parameters'));
          }
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      });

      server.listen(this.callbackPort, 'localhost', () => {
        // Build authorization URL
        const authParams = new URLSearchParams({
          response_type: 'code',
          client_id: this.clientInfo.client_id,
          redirect_uri: `http://localhost:${this.callbackPort}/callback`,
          scope: this.scopes,
          state: pkceParams.state,
          code_challenge: pkceParams.code_challenge,
          code_challenge_method: pkceParams.code_challenge_method
        });

        const authUrl = `${this.oauthServerUrl}/authorize?${authParams.toString()}`;
        
        console.error(`[MCP OAuth] 🌐 Opening browser for authorization: ${authUrl}`);
        
        // Open browser (try different commands for different OS)
        const openCmd = process.platform === 'darwin' ? 'open' : 
                       process.platform === 'win32' ? 'start' : 'xdg-open';
        
        exec(`${openCmd} "${authUrl}"`, (error) => {
          if (error) {
            console.error('[MCP OAuth] ⚠️  Could not open browser automatically');
            console.error(`[MCP OAuth] Please manually open: ${authUrl}`);
          }
        });

        // Set timeout for authorization
        setTimeout(() => {
          server.close();
          reject(new Error('Authorization timeout after 5 minutes'));
        }, 5 * 60 * 1000);
      });
    });
  }

  /**
   * Exchange authorization code for tokens
   */
  async exchangeCodeForTokens(authCode, pkceParams) {
    const tokenData = {
      grant_type: 'authorization_code',
      code: authCode,
      redirect_uri: `http://localhost:${this.callbackPort}/callback`,
      client_id: this.clientInfo.client_id,
      client_secret: this.clientInfo.client_secret,
      code_verifier: pkceParams.code_verifier
    };

    const fetch = (await import('node-fetch')).default;
    const response = await fetch(`${this.oauthServerUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(tokenData).toString()
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token exchange failed: ${response.status} - ${error}`);
    }

    return await response.json();
  }

  /**
   * Get valid access token (refresh if needed)
   */
  async getValidAccessToken() {
    if (!this.accessToken) {
      throw new Error('No access token available');
    }

    // Check if token is expired (with 5 minute buffer)
    if (this.tokenExpiry && Date.now() > (this.tokenExpiry - 5 * 60 * 1000)) {
      console.error('[MCP OAuth] 🔄 Refreshing expired access token...');
      await this.refreshAccessToken();
    }

    return this.accessToken;
  }

  /**
   * Refresh access token
   */
  async refreshAccessToken() {
    if (!this.refreshToken) {
      throw new Error('No refresh token available');
    }

    const tokenData = {
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
      client_id: this.clientInfo.client_id,
      client_secret: this.clientInfo.client_secret
    };

    const fetch = (await import('node-fetch')).default;
    const response = await fetch(`${this.oauthServerUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(tokenData).toString()
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token refresh failed: ${response.status} - ${error}`);
    }

    const tokens = await response.json();
    this.accessToken = tokens.access_token;
    this.tokenExpiry = Date.now() + (tokens.expires_in * 1000);
    
    console.error('[MCP OAuth] ✅ Access token refreshed successfully');
  }
}

class SimpleMCPServer {
  constructor() {
    this.server = new Server(
      {
        name: 'simple-oauth-mcp-server',
        version: '1.0.0'
      },
      {
        capabilities: {
          tools: {}
        }
      }
    );

    // Initialize OAuth client
    this.oauthClient = new MCPOAuthClient({
      oauthServerUrl: process.env.OAUTH_BASE_URL || 'http://localhost:4449',
      clientName: 'Simple MCP Server with OAuth',
      callbackPort: 8848
    });

    this.oauthAuthenticated = false;
    this.setupToolHandlers();
    this.setupErrorHandling();
  }

  setupToolHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'oauth_status',
            description: 'Check OAuth server status and configuration',
            inputSchema: {
              type: 'object',
              properties: {},
              required: []
            }
          },
          {
            name: 'test_tool',
            description: 'Test tool that simulates OAuth-protected functionality',
            inputSchema: {
              type: 'object',
              properties: {
                message: {
                  type: 'string',
                  description: 'Test message to process'
                }
              },
              required: ['message']
            }
          },
          {
            name: 'server_info',
            description: 'Get server information and capabilities',
            inputSchema: {
              type: 'object',
              properties: {},
              required: []
            }
          },
          {
            name: 'oauth_demo',
            description: 'Demonstrate OAuth flow information',
            inputSchema: {
              type: 'object',
              properties: {
                action: {
                  type: 'string',
                  enum: ['status', 'config', 'flow'],
                  description: 'Type of OAuth information to retrieve'
                }
              },
              required: ['action']
            }
          }
        ]
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      
      switch (name) {
        case 'oauth_status':
          return await this.handleOAuthStatus();
          
        case 'test_tool':
          return await this.handleTestTool(args);
          
        case 'server_info':
          return await this.handleServerInfo();
          
        case 'oauth_demo':
          return await this.handleOAuthDemo(args);
          
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    });
  }

  async handleOAuthStatus() {
    const oauthServerUrl = this.oauthClient.oauthServerUrl;
    
    // Try to check OAuth server status
    let oauthServerStatus = 'unknown';
    try {
      const fetch = (await import('node-fetch')).default;
      const response = await fetch(`${oauthServerUrl}/health`, { timeout: 5000 });
      oauthServerStatus = response.ok ? 'online' : 'error';
    } catch (error) {
      oauthServerStatus = 'offline';
    }

    // OAuth client status
    const clientStatus = this.oauthAuthenticated ? 'Authenticated ✅' : 'Not Authenticated ❌';
    const tokenInfo = this.oauthClient.accessToken ? 
      `Present (${this.oauthClient.accessToken.substring(0, 20)}...)` : 'None';

    return {
      content: [
        {
          type: 'text',
          text: `🔐 OAuth Authentication Status Report

🎫 Client Authentication:
• Status: ${clientStatus}
• Client ID: ${this.oauthClient.clientInfo?.client_id || 'Not registered'}
• Access Token: ${tokenInfo}
• Token Expiry: ${this.oauthClient.tokenExpiry ? new Date(this.oauthClient.tokenExpiry).toISOString() : 'Unknown'}

📊 Server Information:
• OAuth Server URL: ${oauthServerUrl}
• Server Status: ${oauthServerStatus}
• Demo Mode: ${process.env.DEMO_MODE === 'true' ? 'Enabled' : 'Disabled'}

🌐 Available Endpoints:
• Authorization: ${oauthServerUrl}/authorize
• Token: ${oauthServerUrl}/token
• Introspection: ${oauthServerUrl}/introspect
• Registration: ${oauthServerUrl}/register
• Health: ${oauthServerUrl}/health

📋 Client Configuration:
• Client Name: ${this.oauthClient.clientName}
• Callback Port: ${this.oauthClient.callbackPort}
• Scopes: ${this.oauthClient.scopes}
• PKCE Required: ${process.env.PKCE_REQUIRED !== 'false' ? 'Yes' : 'No'}

${this.oauthAuthenticated ? 
  '🎉 This MCP server is authenticated and ready for OAuth-protected operations!' : 
  '⚠️  This MCP server completed OAuth authentication during startup.'}
`
        }
      ]
    };
  }

  async handleTestTool(args) {
    const { message = 'Hello from MCP server!' } = args;
    
    return {
      content: [
        {
          type: 'text',
          text: `✅ Test Tool Executed Successfully

📝 Input Message: "${message}"
🕐 Timestamp: ${new Date().toISOString()}
🖥️ Server: simple-oauth-mcp-server v1.0.0
🔧 Transport: stdio (Claude Desktop native)

🔐 OAuth Context:
• This tool would normally require OAuth authentication
• In a full implementation, this would validate Bearer tokens
• Demo mode: ${process.env.DEMO_MODE === 'true' ? 'Enabled' : 'Disabled'}

💡 This demonstrates how MCP tools can provide OAuth-protected functionality.`
        }
      ]
    };
  }

  async handleServerInfo() {
    const memoryUsage = process.memoryUsage();
    
    return {
      content: [
        {
          type: 'text',
          text: `🖥️ Server Information

📋 Basic Info:
• Name: simple-oauth-mcp-server
• Version: 1.0.0
• Protocol: MCP 2024-11-05
• Transport: stdio
• PID: ${process.pid}
• Platform: ${process.platform}
• Node.js: ${process.version}

📊 Runtime Stats:
• Uptime: ${Math.floor(process.uptime())} seconds
• Memory Usage:
  - RSS: ${Math.round(memoryUsage.rss / 1024 / 1024)} MB
  - Heap Used: ${Math.round(memoryUsage.heapUsed / 1024 / 1024)} MB
  - Heap Total: ${Math.round(memoryUsage.heapTotal / 1024 / 1024)} MB

🔧 Capabilities:
• Tools: 4 available tools
• Logging: Supported
• stdio Transport: Native Claude Desktop support

🌟 This server provides a simple MCP interface for OAuth-related functionality.`
        }
      ]
    };
  }

  async handleOAuthDemo(args) {
    const { action } = args;
    
    switch (action) {
      case 'status':
        return {
          content: [
            {
              type: 'text',
              text: `🔐 OAuth Flow Status

📋 Current State: Demo Mode
🔑 Authentication: Simulated (stdio transport)
👤 User: Demo User
🏢 Client: simple-mcp-client

📊 OAuth Configuration:
• Authorization Server: ${process.env.OAUTH_BASE_URL || 'http://localhost:4449'}
• Grant Type: authorization_code
• PKCE: Required
• Scopes: openid profile email mcp:tools

ℹ️ In a real OAuth implementation, this would show actual token status.`
            }
          ]
        };
        
      case 'config':
        return {
          content: [
            {
              type: 'text',
              text: `⚙️ OAuth Configuration

🔧 Environment Variables:
• OAUTH_BASE_URL: ${process.env.OAUTH_BASE_URL || 'http://localhost:4449'}
• DEMO_MODE: ${process.env.DEMO_MODE || 'false'}
• PKCE_REQUIRED: ${process.env.PKCE_REQUIRED || 'true'}

📝 Client Configuration:
• Client ID: ${process.env.DEFAULT_CLIENT_ID || 'mcp-client'}
• Redirect URI: ${process.env.DEFAULT_REDIRECT_URI || 'http://localhost:8847/callback'}
• Scopes: ${process.env.DEFAULT_SCOPES || 'openid email profile mcp:tools'}

🔒 Security Settings:
• HTTPS Required: Production only
• Token Expiry: 1 hour (default)
• Refresh Tokens: Supported

📚 For full OAuth setup, refer to the oauth-server directory.`
            }
          ]
        };
        
      case 'flow':
        return {
          content: [
            {
              type: 'text',
              text: `🔄 OAuth 2.1 + PKCE Flow

📋 Authentication Steps:
1. 🚀 Client generates PKCE challenge
2. 🌐 Redirect to authorization server
3. 👤 User authenticates and consents
4. ✅ Authorization code returned
5. 🔄 Exchange code for tokens (with PKCE verifier)
6. 🎫 Access token + refresh token issued

🔧 MCP Integration:
• Bearer token in Authorization header
• Server-Sent Events for real-time updates
• Token introspection for validation
• Automatic token refresh

📚 Endpoints:
• Authorize: /authorize?response_type=code&client_id=...
• Token: POST /token
• Introspect: POST /introspect

💡 This server demonstrates OAuth concepts for MCP development.`
            }
          ]
        };
        
      default:
        throw new Error(`Unknown OAuth demo action: ${action}`);
    }
  }

  setupErrorHandling() {
    this.server.onerror = (error) => {
      console.error('[MCP Server Error]:', error);
    };

    process.on('SIGINT', async () => {
      console.log('\n🛑 Shutting down MCP server...');
      await this.server.close();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log('\n🛑 Shutting down MCP server...');
      await this.server.close();
      process.exit(0);
    });
  }

  async start() {
    try {
      console.error('🚀 Simple MCP Server with OAuth starting...');
      console.error('📡 Transport: stdio');
      console.error('🔧 Tools: oauth_status, test_tool, server_info, oauth_demo');
      
      // Perform OAuth authentication before starting MCP server
      console.error('');
      console.error('🔐 Starting OAuth 2.1 authentication flow...');
      console.error('   This will open your browser to authenticate with the OAuth server.');
      console.error('');
      
      try {
        await this.oauthClient.authenticate();
        this.oauthAuthenticated = true;
        
        console.error('');
        console.error('🎉 OAuth authentication completed successfully!');
        console.error(`🎫 Access Token: ${this.oauthClient.accessToken.substring(0, 30)}...`);
        console.error(`👤 Client ID: ${this.oauthClient.clientInfo.client_id}`);
        console.error('');
        
      } catch (error) {
        console.error('');
        console.error('❌ OAuth authentication failed:', error.message);
        console.error('⚠️  Starting MCP server without OAuth authentication...');
        console.error('   Tools will show OAuth status but authentication is not available.');
        console.error('');
        this.oauthAuthenticated = false;
      }
      
      console.error('📡 Starting MCP stdio transport...');
      console.error('✅ Ready for Claude Desktop!');
      console.error('');
      console.error('💡 Try using the oauth_status tool to check authentication status.');
      console.error('');
      
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      
    } catch (error) {
      console.error('❌ Failed to start MCP server:', error);
      process.exit(1);
    }
  }
}

// Start the server
const server = new SimpleMCPServer();
server.start().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});