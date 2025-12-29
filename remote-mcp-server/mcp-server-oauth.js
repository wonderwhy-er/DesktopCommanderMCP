#!/usr/bin/env node

/**
 * Remote MCP Server with OAuth2 Authentication (HTTP Transport)
 * 
 * This implements a proper MCP server that follows the MCP authorization specification:
 * https://modelcontextprotocol.io/specification/draft/basic/authorization
 * 
 * Features:
 * - HTTP transport (not stdio)
 * - OAuth 2.1 authorization flow
 * - WWW-Authenticate header for discovery
 * - Bearer token authentication
 * - Integration with Ory Kratos/Hydra
 */

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { HTTPServerTransport } = require("@modelcontextprotocol/sdk/server/http.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  InitializeRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");
const fetch = require('cross-fetch');
const crypto = require('crypto');

class RemoteMCPServerOAuth {
  constructor() {
    this.server = new Server(
      {
        name: "remote-mcp-server-oauth",
        version: "1.0.0",
        description: "Remote MCP Server with OAuth2 authorization"
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // OAuth configuration
    this.authConfig = {
      authorizationServer: process.env.OAUTH_AUTH_SERVER || "http://localhost:4444",
      clientId: process.env.OAUTH_CLIENT_ID || "remote-mcp-client",
      redirectUri: process.env.OAUTH_REDIRECT_URI || "http://localhost:3003/auth/callback",
      scope: process.env.OAUTH_SCOPE || "openid email profile mcp:remote"
    };

    // Connection state
    this.connectionConfig = null;
    this.accessToken = null;

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
          name: "remote-mcp-server-oauth",
          version: "1.0.0"
        }
      };
    });

    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "oauth_connect",
            description: "Start OAuth authentication flow to connect to remote machine",
            inputSchema: {
              type: "object",
              properties: {
                serverUrl: {
                  type: "string",
                  description: "Remote MCP Server URL",
                  default: "http://localhost:3003"
                }
              },
              required: []
            },
          },
          {
            name: "remote_execute",
            description: "Execute MCP tool commands on connected remote machine (requires OAuth)",
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
          case "oauth_connect":
            return await this.handleOAuthConnect(args);
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

  async handleOAuthConnect(args) {
    const { serverUrl = "http://localhost:3003" } = args;
    
    try {
      // Store server URL for later use
      this.connectionConfig = { serverUrl };
      
      // Generate OAuth authorization URL
      const state = crypto.randomBytes(16).toString('hex');
      const codeVerifier = crypto.randomBytes(32).toString('base64url');
      const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
      
      // Store PKCE values (in production, use secure storage)
      this.pkceState = { state, codeVerifier };
      
      const authParams = new URLSearchParams({
        response_type: 'code',
        client_id: this.authConfig.clientId,
        redirect_uri: this.authConfig.redirectUri,
        scope: this.authConfig.scope,
        state: state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        // Resource Indicator (RFC 8707) - specify target resource
        resource: serverUrl
      });

      const authUrl = `${this.authConfig.authorizationServer}/oauth2/auth?${authParams.toString()}`;
      
      return {
        content: [
          {
            type: "text",
            text: `🔐 OAuth Authentication Required\n\n` +
                  `To connect to the remote MCP server (${serverUrl}), please complete OAuth authentication:\n\n` +
                  `1. Click this link: ${authUrl}\n` +
                  `2. Complete login in your browser\n` +
                  `3. Return here and run remote_status to check connection\n\n` +
                  `Note: This follows the MCP Authorization specification for secure access.`
          },
        ],
      };
    } catch (error) {
      throw new Error(`OAuth connection setup failed: ${error.message}`);
    }
  }

  async handleRemoteExecute(args) {
    if (!this.accessToken) {
      return {
        content: [
          {
            type: "text",
            text: "❌ Authentication required. Please run oauth_connect first to authenticate."
          },
        ],
        isError: true,
      };
    }

    const { toolName, arguments: toolArgs } = args;
    const { serverUrl } = this.connectionConfig;

    try {
      // Create MCP request with OAuth bearer token
      const mcpRequest = {
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
          name: toolName,
          arguments: toolArgs
        }
      };

      const response = await fetch(`${serverUrl}/api/mcp/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.accessToken}`,
          "Accept": "application/json"
        },
        body: JSON.stringify(mcpRequest)
      });

      if (response.status === 401) {
        // Token expired or invalid - follow MCP spec for re-authentication
        this.accessToken = null;
        return {
          content: [
            {
              type: "text",
              text: "🔐 Authorization expired. Please run oauth_connect to re-authenticate."
            },
          ],
          isError: true,
        };
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`MCP execution failed: ${response.status} - ${errorText}`);
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
    if (!this.connectionConfig) {
      return {
        content: [
          {
            type: "text",
            text: "❌ Not configured. Run oauth_connect first to set up the connection."
          },
        ],
      };
    }

    const { serverUrl } = this.connectionConfig;
    const isAuthenticated = !!this.accessToken;

    try {
      // Check server health
      const healthResponse = await fetch(`${serverUrl}/health`);
      const health = await healthResponse.json();

      return {
        content: [
          {
            type: "text",
            text: `🔍 Remote MCP Connection Status:\n\n` +
                  `Server URL: ${serverUrl}\n` +
                  `Server Status: ${health.status || 'Unknown'}\n` +
                  `OAuth Authentication: ${isAuthenticated ? '✅ Authenticated' : '❌ Not authenticated'}\n` +
                  `Authorization Server: ${this.authConfig.authorizationServer}\n` +
                  `Client ID: ${this.authConfig.clientId}\n\n` +
                  `${isAuthenticated ? 'Ready for remote operations!' : 'Run oauth_connect to authenticate.'}`
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `⚠️ Status check failed: ${error.message}\n` +
                  `Server URL: ${serverUrl}\n` +
                  `Authentication: ${isAuthenticated ? 'Authenticated' : 'Not authenticated'}\n` +
                  `The server may be down or unreachable.`
          },
        ],
      };
    }
  }

  // Method to handle OAuth callback (would be called after user completes OAuth)
  async handleOAuthCallback(code, state) {
    if (!this.pkceState || this.pkceState.state !== state) {
      throw new Error("Invalid OAuth state parameter");
    }

    try {
      // Exchange authorization code for access token with PKCE
      const tokenRequest = {
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: this.authConfig.redirectUri,
        client_id: this.authConfig.clientId,
        code_verifier: this.pkceState.codeVerifier
      };

      const tokenResponse = await fetch(`${this.authConfig.authorizationServer}/oauth2/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(tokenRequest)
      });

      if (!tokenResponse.ok) {
        throw new Error(`Token exchange failed: ${tokenResponse.status}`);
      }

      const tokens = await tokenResponse.json();
      this.accessToken = tokens.access_token;
      
      // Clean up PKCE state
      this.pkceState = null;
      
      console.log('✅ OAuth authentication successful');
      return tokens;
    } catch (error) {
      throw new Error(`OAuth callback handling failed: ${error.message}`);
    }
  }

  async run() {
    // Create HTTP transport instead of stdio
    const transport = new HTTPServerTransport({
      port: process.env.MCP_SERVER_PORT || 3004,
      // Add WWW-Authenticate header for authorization discovery (MCP spec requirement)
      middleware: (req, res, next) => {
        // Set CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        
        // Check for authorization header
        const authHeader = req.headers.authorization;
        if (!authHeader && req.method !== 'OPTIONS') {
          // Return WWW-Authenticate header as per MCP spec
          res.setHeader('WWW-Authenticate', 
            `Bearer realm="remote-mcp", ` +
            `authorization_uri="${this.authConfig.authorizationServer}/oauth2/auth", ` +
            `client_id="${this.authConfig.clientId}", ` +
            `scope="${this.authConfig.scope}"`
          );
        }
        
        next();
      }
    });

    await this.server.connect(transport);
    
    const port = process.env.MCP_SERVER_PORT || 3004;
    console.error(`🚀 Remote MCP Server with OAuth running on HTTP port ${port}`);
    console.error(`📋 MCP Authorization Server: ${this.authConfig.authorizationServer}`);
    console.error(`🔑 Client ID: ${this.authConfig.clientId}`);
    console.error(`🎯 Add to Claude Desktop as HTTP MCP server: http://localhost:${port}`);
    console.error('');
    console.error('💡 This server implements the MCP Authorization specification');
    console.error('   https://modelcontextprotocol.io/specification/draft/basic/authorization');
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.error('\\n🛑 Shutting down MCP Server...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.error('\\n🛑 Shutting down MCP Server...');
  process.exit(0);
});

// Start the server
const server = new RemoteMCPServerOAuth();
server.run().catch((error) => {
  console.error('💥 Server failed to start:', error);
  process.exit(1);
});