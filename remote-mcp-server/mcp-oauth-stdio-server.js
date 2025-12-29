#!/usr/bin/env node

/**
 * MCP OAuth Stdio Server
 * 
 * This is a proper MCP server that works with Claude Desktop via stdio
 * and handles OAuth authentication automatically.
 */

// Load environment variables
require('dotenv').config();

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { exec } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const fetch = require('cross-fetch');

class MCPOAuthServer {
  constructor() {
    // Load configuration from environment variables
    this.mcpServerUrl = process.env.MCP_SERVER_URL || 'http://localhost:3006';
    this.oauthServerUrl = process.env.OAUTH_AUTH_SERVER_URL || 'http://localhost:4449';
    this.remoteServerUrl = process.env.REMOTE_DC_SERVER_URL || 'http://localhost:3002';
    this.clientId = process.env.OAUTH_CLIENT_ID || 'remote-mcp-client';
    this.clientSecret = process.env.OAUTH_CLIENT_SECRET || 'remote-mcp-secret-change-in-production';
    this.scopes = process.env.OAUTH_SCOPES || 'openid email profile mcp:tools';
    
    this.accessToken = null;
    this.tokenExpiry = null;
    this.isAuthenticating = false;
    this.authPromise = null;
    
    this.log('🔐 MCP OAuth Server starting...');
    this.log(`📡 OAuth Server: ${this.oauthServerUrl}`);
    this.log(`🎯 Remote Server: ${this.remoteServerUrl}`);
  }

  log(message) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] ${message}`);
  }

  async initialize() {
    // Create MCP server
    this.server = new Server(
      {
        name: 'remote-mcp-oauth',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Register tool handlers
    this.server.setRequestHandler('tools/list', () => this.handleToolsList());
    this.server.setRequestHandler('tools/call', (request) => this.handleToolCall(request));

    // Create stdio transport
    this.transport = new StdioServerTransport();
    
    this.log('✅ MCP server initialized');
  }

  async handleToolsList() {
    this.log('📋 Tools list requested - checking authentication...');
    
    try {
      await this.ensureAuthenticated();
      
      // Get tools from remote server
      const tools = await this.getRemoteTools();
      
      this.log(`📋 Retrieved ${tools.length} tools from remote server`);
      return { tools };
      
    } catch (error) {
      this.log(`❌ Error getting tools: ${error.message}`);
      return {
        tools: [
          {
            name: 'authenticate',
            description: 'Authenticate with OAuth server',
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
    
    this.log(`🔧 Tool call: ${name}`);
    
    if (name === 'authenticate') {
      try {
        await this.performOAuthFlow();
        return {
          content: [
            {
              type: 'text',
              text: '✅ OAuth authentication completed successfully! You can now use remote tools.'
            }
          ]
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text', 
              text: `❌ Authentication failed: ${error.message}`
            }
          ]
        };
      }
    }

    try {
      await this.ensureAuthenticated();
      
      // Forward to remote server
      const result = await this.callRemoteTool(name, args);
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
      
    } catch (error) {
      this.log(`❌ Tool call error: ${error.message}`);
      return {
        content: [
          {
            type: 'text',
            text: `❌ Error: ${error.message}`
          }
        ]
      };
    }
  }

  async ensureAuthenticated() {
    // Check if we have a valid token
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return;
    }

    // If authentication is already in progress, wait for it
    if (this.isAuthenticating && this.authPromise) {
      return await this.authPromise;
    }

    // Start authentication
    this.isAuthenticating = true;
    this.authPromise = this.performOAuthFlow();
    
    try {
      await this.authPromise;
    } finally {
      this.isAuthenticating = false;
      this.authPromise = null;
    }
  }

  async performOAuthFlow() {
    this.log('🔄 Starting OAuth flow...');
    
    try {
      // 1. Register OAuth client
      const clientInfo = await this.registerOAuthClient();
      this.log('✅ OAuth client registered');

      // 2. Generate PKCE parameters
      const codeVerifier = crypto.randomBytes(32).toString('base64url');
      const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
      const state = crypto.randomBytes(16).toString('hex');

      // 3. Build authorization URL
      const authEndpoint = process.env.OAUTH_AUTHORIZE_ENDPOINT || '/authorize';
      const redirectUri = 'http://localhost:8847/callback';
      
      const authParams = new URLSearchParams({
        response_type: 'code',
        client_id: clientInfo.client_id,
        redirect_uri: redirectUri,
        scope: this.scopes,
        state: state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256'
      });

      const authUrl = `${this.oauthServerUrl}${authEndpoint}?${authParams.toString()}`;
      
      this.log(`🌐 Opening browser for OAuth authentication...`);
      this.log(`🔗 URL: ${authUrl}`);

      // 4. Start callback server and open browser
      const authCode = await this.waitForCallback(authUrl, state, redirectUri);
      
      // 5. Exchange code for token
      const tokenInfo = await this.exchangeCodeForToken(
        authCode, 
        clientInfo,
        redirectUri,
        codeVerifier
      );

      // 6. Store token info
      this.accessToken = tokenInfo.access_token;
      this.tokenExpiry = Date.now() + (tokenInfo.expires_in * 1000);
      
      this.log('✅ OAuth flow completed successfully');
      
    } catch (error) {
      this.log(`❌ OAuth flow failed: ${error.message}`);
      throw error;
    }
  }

  async registerOAuthClient() {
    const registerEndpoint = process.env.OAUTH_REGISTER_ENDPOINT || '/register';
    const clientRegistration = {
      client_name: 'MCP OAuth Client',
      redirect_uris: ['http://localhost:8847/callback'],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      scope: this.scopes
    };

    const response = await fetch(`${this.oauthServerUrl}${registerEndpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(clientRegistration)
    });

    if (!response.ok) {
      throw new Error(`Client registration failed: ${response.status}`);
    }

    return await response.json();
  }

  async waitForCallback(authUrl, expectedState, redirectUri) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        if (req.url?.startsWith('/callback')) {
          const url = new URL(req.url, 'http://localhost:8847');
          const code = url.searchParams.get('code');
          const state = url.searchParams.get('state');
          const error = url.searchParams.get('error');

          if (error) {
            res.writeHead(400, {'Content-Type': 'text/html'});
            res.end(`<html><body><h1>❌ Authentication Failed</h1><p>${error}</p></body></html>`);
            server.close();
            reject(new Error(`OAuth error: ${error}`));
            return;
          }

          if (!code || state !== expectedState) {
            res.writeHead(400, {'Content-Type': 'text/html'});
            res.end('<html><body><h1>❌ Invalid OAuth Response</h1></body></html>');
            server.close();
            reject(new Error('Invalid OAuth callback'));
            return;
          }

          res.writeHead(200, {'Content-Type': 'text/html'});
          res.end('<html><body><h1>✅ Authentication Successful</h1><p>You can close this window.</p></body></html>');
          
          server.close();
          resolve(code);
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      server.listen(8847, () => {
        this.log('🔗 OAuth callback server started on port 8847');
        
        // Open browser
        const openCommand = process.platform === 'darwin' ? 'open' : 
                           process.platform === 'win32' ? 'start' : 'xdg-open';
        
        exec(`${openCommand} "${authUrl}"`, (error) => {
          if (error) {
            this.log(`⚠️ Could not open browser: ${error.message}`);
            this.log(`🖱️ Please manually open: ${authUrl}`);
          }
        });
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        server.close();
        reject(new Error('OAuth flow timeout'));
      }, 300000);
    });
  }

  async exchangeCodeForToken(authCode, clientInfo, redirectUri, codeVerifier) {
    const tokenEndpoint = process.env.OAUTH_TOKEN_ENDPOINT || '/token';
    const tokenData = new URLSearchParams({
      grant_type: 'authorization_code',
      code: authCode,
      redirect_uri: redirectUri,
      client_id: clientInfo.client_id,
      client_secret: clientInfo.client_secret,
      code_verifier: codeVerifier
    });

    const response = await fetch(`${this.oauthServerUrl}${tokenEndpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenData
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token exchange failed: ${response.status} - ${error}`);
    }

    return await response.json();
  }

  async getRemoteTools() {
    if (!this.accessToken) {
      throw new Error('Not authenticated');
    }

    const response = await fetch(`${this.remoteServerUrl}/api/mcp/tools`, {
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to get tools: ${response.status}`);
    }

    const result = await response.json();
    return result.tools || [];
  }

  async callRemoteTool(name, args) {
    if (!this.accessToken) {
      throw new Error('Not authenticated');
    }

    const mcpRequest = {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name, arguments: args }
    };

    const remoteEndpoint = process.env.REMOTE_DC_SERVER_ENDPOINT || '/api/mcp/execute';
    const response = await fetch(`${this.remoteServerUrl}${remoteEndpoint}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(mcpRequest)
    });

    if (!response.ok) {
      throw new Error(`Remote tool call failed: ${response.status}`);
    }

    const result = await response.json();
    return result.result || result;
  }

  async start() {
    await this.initialize();
    
    // Connect to stdio transport
    await this.server.connect(this.transport);
    
    this.log('✅ MCP OAuth Server connected via stdio');
  }
}

// Start the server
if (require.main === module) {
  const server = new MCPOAuthServer();
  
  server.start().catch(error => {
    console.error('❌ Failed to start MCP OAuth server:', error);
    process.exit(1);
  });

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.error('\n🛑 Shutting down MCP OAuth Server...');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.error('\n🛑 Shutting down MCP OAuth Server...');
    process.exit(0);
  });
}