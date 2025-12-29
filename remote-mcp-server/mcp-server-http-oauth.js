#!/usr/bin/env node

/**
 * MCP Server with HTTP Transport and OAuth2 Authentication
 * 
 * This implements a proper MCP server that follows the MCP authorization specification:
 * https://modelcontextprotocol.io/specification/draft/basic/authorization
 * 
 * Features:
 * - HTTP transport using StreamableHTTPServerTransport
 * - OAuth 2.1 authorization flow with PKCE
 * - Integration with Ory Kratos/Hydra
 * - WWW-Authenticate header for authorization discovery
 * - Bearer token authentication
 * - Protected resource metadata endpoints
 */

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { createMcpExpressApp } = require("@modelcontextprotocol/sdk/server/express.js");
const { mcpAuthRouter } = require("@modelcontextprotocol/sdk/server/auth/router.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  InitializeRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");
const express = require('express');
const fetch = require('cross-fetch');
const crypto = require('crypto');

/**
 * OAuth Provider that integrates with Ory Kratos/Hydra
 */
class OryOAuthProvider {
  constructor(kratoUrl, hydraUrl) {
    this.kratoUrl = kratoUrl;
    this.hydraUrl = hydraUrl;
    this.tokens = new Map(); // In-memory token storage for demo
    this.codes = new Map();  // In-memory authorization codes
    this.clientsStore = new OryClientsStore(hydraUrl);
  }

  async authorize(client, params, res) {
    // Generate authorization code
    const code = crypto.randomUUID();
    
    // Store authorization parameters
    this.codes.set(code, {
      client,
      params,
      createdAt: Date.now()
    });

    // Build redirect URL with authorization code
    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set('code', code);
    if (params.state) {
      redirectUrl.searchParams.set('state', params.state);
    }

    // Validate redirect URI
    if (!client.redirect_uris.includes(params.redirectUri)) {
      throw new Error('Invalid redirect_uri');
    }

    // In a real implementation, you would redirect to Kratos for authentication
    // For now, we'll simulate user authentication
    console.log(`🔐 OAuth authorization request for client: ${client.client_id}`);
    console.log(`📍 Redirect URI: ${params.redirectUri}`);
    console.log(`🎯 Scopes: ${params.scopes?.join(' ') || 'none'}`);
    
    res.redirect(redirectUrl.toString());
  }

  async challengeForAuthorizationCode(client, authorizationCode) {
    const codeData = this.codes.get(authorizationCode);
    if (!codeData) {
      throw new Error('Invalid authorization code');
    }
    return codeData.params.codeChallenge;
  }

  async exchangeAuthorizationCode(client, authorizationCode, codeVerifier) {
    const codeData = this.codes.get(authorizationCode);
    
    if (!codeData) {
      throw new Error('Invalid authorization code');
    }

    if (codeData.client.client_id !== client.client_id) {
      throw new Error('Authorization code was not issued to this client');
    }

    // Verify PKCE code challenge
    if (codeData.params.codeChallenge) {
      const expectedChallenge = crypto
        .createHash('sha256')
        .update(codeVerifier)
        .digest('base64url');
      
      console.log('PKCE Debug:', {
        receivedVerifier: codeVerifier,
        expectedChallenge,
        storedChallenge: codeData.params.codeChallenge,
        match: expectedChallenge === codeData.params.codeChallenge
      });
      
      if (expectedChallenge !== codeData.params.codeChallenge) {
        throw new Error('Invalid code verifier');
      }
    }

    // Clean up used authorization code
    this.codes.delete(authorizationCode);

    // Generate access token
    const accessToken = crypto.randomUUID();
    const expiresAt = Date.now() + (3600 * 1000); // 1 hour

    // Store token
    this.tokens.set(accessToken, {
      clientId: client.client_id,
      scopes: codeData.params.scopes || [],
      expiresAt,
      resource: codeData.params.resource,
      type: 'access'
    });

    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: 3600,
      scope: (codeData.params.scopes || []).join(' ')
    };
  }

  async exchangeRefreshToken(client, refreshToken, scopes, resource) {
    throw new Error('Refresh tokens not implemented in this demo');
  }

  async verifyAccessToken(token) {
    const tokenData = this.tokens.get(token);
    
    if (!tokenData) {
      throw new Error('Invalid token');
    }

    if (tokenData.expiresAt < Date.now()) {
      this.tokens.delete(token);
      throw new Error('Token expired');
    }

    return {
      token,
      clientId: tokenData.clientId,
      scopes: tokenData.scopes,
      expiresAt: Math.floor(tokenData.expiresAt / 1000),
      resource: tokenData.resource
    };
  }

  async revokeToken(client, token, tokenTypeHint) {
    this.tokens.delete(token);
    return true;
  }
}

/**
 * OAuth Clients Store for Ory Hydra integration
 */
class OryClientsStore {
  constructor(hydraUrl) {
    this.hydraUrl = hydraUrl;
    this.clients = new Map(); // Cache for demo
  }

  async getClient(clientId) {
    // Check cache first
    if (this.clients.has(clientId)) {
      return this.clients.get(clientId);
    }

    try {
      // Fetch from Hydra
      const response = await fetch(`${this.hydraUrl}/admin/clients/${clientId}`);
      if (!response.ok) {
        if (response.status === 404) {
          return null;
        }
        throw new Error(`Failed to fetch client: ${response.status}`);
      }

      const client = await response.json();
      
      // Convert Hydra client format to MCP format
      const mcpClient = {
        client_id: client.client_id,
        client_secret: client.client_secret,
        redirect_uris: client.redirect_uris || [],
        grant_types: client.grant_types || ['authorization_code'],
        response_types: client.response_types || ['code'],
        scope: client.scope || '',
        token_endpoint_auth_method: client.token_endpoint_auth_method || 'client_secret_post'
      };

      // Cache the client
      this.clients.set(clientId, mcpClient);
      return mcpClient;
    } catch (error) {
      console.error(`Error fetching client ${clientId}:`, error);
      return null;
    }
  }

  async registerClient(clientMetadata) {
    try {
      // Register with Hydra
      const response = await fetch(`${this.hydraUrl}/admin/clients`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          client_id: clientMetadata.client_id,
          client_secret: clientMetadata.client_secret,
          redirect_uris: clientMetadata.redirect_uris,
          grant_types: clientMetadata.grant_types || ['authorization_code'],
          response_types: clientMetadata.response_types || ['code'],
          scope: clientMetadata.scope || '',
          token_endpoint_auth_method: clientMetadata.token_endpoint_auth_method || 'client_secret_post'
        })
      });

      if (!response.ok) {
        throw new Error(`Failed to register client: ${response.status}`);
      }

      const client = await response.json();
      
      // Cache the client
      this.clients.set(client.client_id, clientMetadata);
      return clientMetadata;
    } catch (error) {
      console.error('Error registering client:', error);
      throw error;
    }
  }
}

/**
 * Authentication middleware to verify Bearer tokens
 */
function authenticateBearer(provider) {
  return async (req, res, next) => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      // Set WWW-Authenticate header for OAuth discovery (MCP spec requirement)
      res.setHeader('WWW-Authenticate', 
        'Bearer realm="mcp", ' +
        'authorization_uri="http://localhost:3004/authorize", ' +
        'client_id="remote-mcp-client", ' +
        'scope="mcp:tools mcp:remote"'
      );
      return res.status(401).json({
        error: 'unauthorized',
        message: 'Bearer token required'
      });
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    try {
      const tokenInfo = await provider.verifyAccessToken(token);
      req.auth = {
        token,
        clientId: tokenInfo.clientId,
        scopes: tokenInfo.scopes,
        expiresAt: tokenInfo.expiresAt,
        resource: tokenInfo.resource
      };
      next();
    } catch (error) {
      res.setHeader('WWW-Authenticate', 
        'Bearer realm="mcp", ' +
        'error="invalid_token", ' +
        'error_description="' + error.message + '"'
      );
      return res.status(401).json({
        error: 'invalid_token',
        message: error.message
      });
    }
  };
}

class RemoteMCPServerHTTPOAuth {
  constructor() {
    // OAuth configuration
    this.authConfig = {
      kratoUrl: process.env.KRATOS_URL || "http://localhost:4433",
      hydraUrl: process.env.HYDRA_URL || "http://localhost:4445", 
      issuerUrl: new URL(process.env.OAUTH_ISSUER_URL || "http://localhost:3004"),
      clientId: process.env.OAUTH_CLIENT_ID || "remote-mcp-client",
      scope: "mcp:tools mcp:remote"
    };

    // Create OAuth provider
    this.oauthProvider = new OryOAuthProvider(
      this.authConfig.kratoUrl,
      this.authConfig.hydraUrl
    );

    // Create MCP server
    this.server = new Server(
      {
        name: "remote-mcp-server-http-oauth",
        version: "1.0.0",
        description: "Remote MCP Server with HTTP transport and OAuth2 authorization"
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Connection state
    this.connectionConfig = null;

    this.setupHandlers();
  }

  setupHandlers() {
    // Initialize handler - required by MCP spec
    this.server.setRequestHandler(InitializeRequestSchema, async (request) => {
      return {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "remote-mcp-server-http-oauth",
          version: "1.0.0"
        }
      };
    });

    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "remote_execute",
            description: "Execute MCP tool commands on remote machine (requires OAuth)",
            inputSchema: {
              type: "object",
              properties: {
                toolName: {
                  type: "string",
                  description: "Desktop Commander tool to execute",
                  enum: ["read_file", "write_file", "list_directory", "start_process", "get_file_info"]
                },
                arguments: {
                  type: "object",
                  description: "Arguments for the tool"
                }
              },
              required: ["toolName", "arguments"]
            },
          },
          {
            name: "remote_status",
            description: "Check remote connection and authentication status",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false
            }
          }
        ],
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case "remote_execute":
            return await this.handleRemoteExecute(args);
          case "remote_status":
            return await this.handleStatus(args);
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  async handleRemoteExecute(args) {
    const { toolName, arguments: toolArgs } = args;
    const serverUrl = "http://localhost:3002"; // Remote Desktop Commander server

    try {
      // Create MCP request
      const mcpRequest = {
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
          name: toolName,
          arguments: toolArgs
        }
      };

      // Note: In a real implementation, you would get the access token from the request context
      // For now, we'll simulate this
      const response = await fetch(`${serverUrl}/api/mcp/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // "Authorization": `Bearer ${accessToken}`,
          "Accept": "application/json"
        },
        body: JSON.stringify(mcpRequest)
      });

      if (!response.ok) {
        throw new Error(`Remote execution failed: ${response.status}`);
      }

      const result = await response.json();

      if (result.error) {
        throw new Error(`Remote MCP Error: ${result.error.message}`);
      }

      return {
        content: [
          {
            type: "text",
            text: `✅ Remote tool '${toolName}' executed successfully:\n\n` +
                  `${JSON.stringify(result.result, null, 2)}`
          },
        ],
      };
    } catch (error) {
      throw new Error(`Remote execution failed: ${error.message}`);
    }
  }

  async handleStatus(args) {
    return {
      content: [
        {
          type: "text",
          text: `🔍 MCP Server Status:\n\n` +
                `Server: HTTP with OAuth2 authentication\n` +
                `Port: ${process.env.MCP_SERVER_PORT || 3004}\n` +
                `OAuth Issuer: ${this.authConfig.issuerUrl.href}\n` +
                `Kratos URL: ${this.authConfig.kratoUrl}\n` +
                `Hydra URL: ${this.authConfig.hydraUrl}\n` +
                `Client ID: ${this.authConfig.clientId}\n\n` +
                `🔐 Authentication: OAuth 2.1 with PKCE\n` +
                `📋 Scopes: ${this.authConfig.scope}\n` +
                `🛡️ Transport: HTTP with Bearer tokens`
        },
      ],
    };
  }

  async run() {
    const port = process.env.MCP_SERVER_PORT || 3004;
    
    // Create Express app with MCP configuration
    const app = createMcpExpressApp({
      host: '127.0.0.1'
    });

    // Add CORS support
    app.use((req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      
      if (req.method === 'OPTIONS') {
        return res.status(204).end();
      }
      
      next();
    });

    // Add OAuth routes (authorization server endpoints)
    app.use(mcpAuthRouter({
      provider: this.oauthProvider,
      issuerUrl: this.authConfig.issuerUrl,
      scopesSupported: ['mcp:tools', 'mcp:remote'],
      resourceName: 'Remote MCP Server',
      serviceDocumentationUrl: new URL('https://modelcontextprotocol.io/')
    }));

    // Create transport with authentication middleware
    const transport = new StreamableHTTPServerTransport();
    
    // Add authentication middleware to the app for MCP requests
    app.use('/mcp', authenticateBearer(this.oauthProvider));
    
    // Handle MCP requests
    app.all('/mcp', async (req, res) => {
      await transport.handleRequest(req, res);
    });
    
    app.all(/\/mcp\/.*/, async (req, res) => {
      await transport.handleRequest(req, res);
    });

    // Health endpoint
    app.get('/health', (req, res) => {
      res.json({
        status: 'ok',
        server: 'remote-mcp-server-http-oauth',
        oauth: {
          issuer: this.authConfig.issuerUrl.href,
          client_id: this.authConfig.clientId,
          scopes: this.authConfig.scope
        },
        timestamp: new Date().toISOString()
      });
    });

    // Connect MCP server to transport
    await this.server.connect(transport);
    
    // Start HTTP server
    app.listen(port, () => {
      console.error(`🚀 MCP Server with HTTP OAuth running on port ${port}`);
      console.error(`📋 OAuth Issuer: ${this.authConfig.issuerUrl.href}`);
      console.error(`🔑 Client ID: ${this.authConfig.clientId}`);
      console.error(`🎯 MCP Endpoint: http://localhost:${port}/mcp`);
      console.error(`💚 Health: http://localhost:${port}/health`);
      console.error('');
      console.error('🔐 OAuth Endpoints:');
      console.error(`   Authorization: http://localhost:${port}/authorize`);
      console.error(`   Token: http://localhost:${port}/token`);
      console.error(`   Metadata: http://localhost:${port}/.well-known/oauth-authorization-server`);
      console.error('');
      console.error('💡 This server implements the MCP Authorization specification:');
      console.error('   https://modelcontextprotocol.io/specification/draft/basic/authorization');
    });
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.error('\n🛑 Shutting down MCP Server...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.error('\n🛑 Shutting down MCP Server...');
  process.exit(0);
});

// Start the server
const server = new RemoteMCPServerHTTPOAuth();
server.run().catch((error) => {
  console.error('💥 Server failed to start:', error);
  process.exit(1);
});