#!/usr/bin/env node

/**
 * MCP Server with HTTP Transport and OAuth2 Authentication - Specification Compliant
 * 
 * This implements a proper MCP server that follows the MCP authorization specification:
 * https://modelcontextprotocol.io/specification/draft/basic/authorization
 * 
 * Based on the official MCP SDK OAuth demo implementation
 */

// Load environment variables
require('dotenv').config();

// Enhanced logging setup
const fs = require('fs');
const path = require('path');

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir);
}

// Set up log file
const logFile = path.join(logsDir, `mcp-oauth-server-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);

// Enhanced logger function
function log(level, message, data = null) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level,
    message,
    data: data || undefined,
    pid: process.pid,
    memory: process.memoryUsage(),
    uptime: process.uptime()
  };
  
  const logLine = JSON.stringify(logEntry) + '\n';
  
  // Write to file
  fs.appendFileSync(logFile, logLine);
  
  // Also log to console
  console.error(`[${timestamp}] ${level.toUpperCase()}: ${message}`);
  if (data) {
    console.error('  Data:', JSON.stringify(data, null, 2));
  }
}

// Log process events
process.on('SIGTERM', () => {
  log('WARN', 'Received SIGTERM signal');
  process.exit(0);
});

process.on('SIGINT', () => {
  log('WARN', 'Received SIGINT signal');
  process.exit(0);
});

process.on('SIGHUP', () => {
  log('WARN', 'Received SIGHUP signal');
});

process.on('SIGUSR1', () => {
  log('WARN', 'Received SIGUSR1 signal');
});

process.on('SIGUSR2', () => {
  log('WARN', 'Received SIGUSR2 signal');
});

process.on('exit', (code) => {
  log('INFO', `Process exiting with code: ${code}`);
});

process.on('uncaughtException', (error) => {
  log('ERROR', 'Uncaught exception', {
    name: error.name,
    message: error.message,
    stack: error.stack
  });
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  log('ERROR', 'Unhandled promise rejection', {
    reason: reason?.toString(),
    stack: reason?.stack
  });
});

log('INFO', 'Starting MCP OAuth Server with enhanced logging', {
  nodeVersion: process.version,
  platform: process.platform,
  arch: process.arch,
  argv: process.argv,
  env: {
    NODE_ENV: process.env.NODE_ENV,
    MCP_SERVER_PORT: process.env.MCP_SERVER_PORT,
    OAUTH_AUTH_PORT: process.env.OAUTH_AUTH_PORT
  },
  logFile
});

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { SSEServerTransport } = require("@modelcontextprotocol/sdk/server/sse.js");
const { createMcpExpressApp } = require("@modelcontextprotocol/sdk/server/express.js");
const { mcpAuthRouter } = require("@modelcontextprotocol/sdk/server/auth/router.js");
const { DemoInMemoryAuthProvider, setupAuthServer } = require("@modelcontextprotocol/sdk/examples/server/demoInMemoryOAuthProvider.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  InitializeRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");
const express = require('express');
const fetch = require('cross-fetch');

class RemoteMCPServerSpecCompliant {
  constructor() {
    log('INFO', 'Initializing RemoteMCPServerSpecCompliant class');
    
    // Server configuration from environment variables
    this.serverConfig = {
      host: process.env.MCP_SERVER_HOST || 'localhost',
      port: parseInt(process.env.MCP_SERVER_PORT) || 3005,
      authHost: process.env.OAUTH_AUTH_HOST || 'localhost', 
      authPort: parseInt(process.env.OAUTH_AUTH_PORT) || 4448,
      remoteServerHost: process.env.REMOTE_DC_SERVER_HOST || 'localhost',
      remoteServerPort: parseInt(process.env.REMOTE_DC_SERVER_PORT) || 3002
    };

    // URLs from environment variables
    this.urls = {
      mcpServer: process.env.MCP_SERVER_URL || `http://${this.serverConfig.host}:${this.serverConfig.port}`,
      authServer: process.env.OAUTH_AUTH_SERVER_URL || `http://${this.serverConfig.authHost}:${this.serverConfig.authPort}`,
      remoteServer: process.env.REMOTE_DC_SERVER_URL || `http://${this.serverConfig.remoteServerHost}:${this.serverConfig.remoteServerPort}`
    };

    // Endpoints from environment variables
    this.endpoints = {
      mcp: {
        sse: process.env.MCP_SSE_ENDPOINT || '/sse',
        message: process.env.MCP_MESSAGE_ENDPOINT || '/message',
        health: process.env.MCP_HEALTH_ENDPOINT || '/health'
      },
      oauth: {
        authorize: process.env.OAUTH_AUTHORIZE_ENDPOINT || '/authorize',
        token: process.env.OAUTH_TOKEN_ENDPOINT || '/token',
        register: process.env.OAUTH_REGISTER_ENDPOINT || '/register',
        introspect: process.env.OAUTH_INTROSPECT_ENDPOINT || '/introspect',
        metadata: process.env.OAUTH_METADATA_ENDPOINT || '/.well-known/oauth-authorization-server'
      },
      remote: {
        execute: process.env.REMOTE_DC_SERVER_ENDPOINT || '/api/mcp/execute'
      }
    };

    log('INFO', 'Server configuration set', { 
      config: this.serverConfig,
      urls: this.urls,
      endpoints: this.endpoints
    });

    this.authServerUrl = new URL(this.urls.authServer);
    this.mcpServerUrl = new URL(this.urls.mcpServer);
    
    log('INFO', 'Server URLs configured', {
      authServerUrl: this.authServerUrl.href,
      mcpServerUrl: this.mcpServerUrl.href
    });

    // Create MCP server
    log('INFO', 'Creating MCP server instance');
    this.server = new Server(
      {
        name: "remote-mcp-server-spec-compliant",
        version: "1.0.0",
        description: "Remote MCP Server with specification-compliant OAuth2 authorization"
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );
    
    log('INFO', 'MCP server instance created successfully');
    this.setupHandlers();
  }

  setupHandlers() {
    log('INFO', 'Setting up MCP handlers');
    
    // Initialize handler - required by MCP spec
    this.server.setRequestHandler(InitializeRequestSchema, async (request) => {
      log('DEBUG', 'Received initialize request', request);
      return {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "remote-mcp-server-spec-compliant",
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
    this.server.setRequestHandler(CallToolRequestSchema, async (request, context) => {
      const { name, arguments: args } = request.params;

      // Check authentication from context
      if (!context?.authInfo?.token) {
        return {
          content: [
            {
              type: "text",
              text: "❌ Authentication required. Please authenticate using OAuth2 first.",
            },
          ],
          isError: true,
        };
      }

      try {
        switch (name) {
          case "remote_execute":
            return await this.handleRemoteExecute(args, context.authInfo);
          case "remote_status":
            return await this.handleStatus(args, context.authInfo);
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

  async handleRemoteExecute(args, authInfo) {
    const { toolName, arguments: toolArgs } = args;

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

      // Execute on remote server using configured URL and endpoint
      const remoteEndpoint = `${this.urls.remoteServer}${this.endpoints.remote.execute}`;
      const response = await fetch(remoteEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
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

  async handleStatus(args, authInfo) {
    return {
      content: [
        {
          type: "text",
          text: `🔍 MCP Server Status:\n\n` +
                `Server: HTTP with OAuth2 authentication\n` +
                `Host: ${this.serverConfig.host}:${this.serverConfig.port}\n` +
                `Auth Server: ${this.authServerUrl.href}\n` +
                `Remote Server: ${this.urls.remoteServer}\n` +
                `Client ID: ${authInfo.clientId}\n` +
                `Scopes: ${authInfo.scopes?.join(' ') || 'none'}\n` +
                `Token Expires: ${new Date(authInfo.expiresAt * 1000).toISOString()}\n\n` +
                `🔐 Authentication: OAuth 2.1 with PKCE\n` +
                `🛡️ Transport: SSE with Bearer tokens\n` +
                `✅ Authenticated and ready for operations!`
        },
      ],
    };
  }

  async run() {
    try {
      log('INFO', 'Starting server initialization');
      
      // Setup OAuth authorization server using the demo implementation
      log('INFO', 'Setting up OAuth authorization server');
      const oauthMetadata = setupAuthServer({
        authServerUrl: this.authServerUrl,
        mcpServerUrl: this.mcpServerUrl,
        strictResource: true // Enable resource validation
      });

      log('INFO', 'OAuth Authorization Server started', {
        port: this.serverConfig.authPort,
        metadata: oauthMetadata
      });
      
      console.error(`🔐 OAuth Authorization Server started on port ${this.serverConfig.authPort}`);
      console.error(`📋 OAuth Metadata:`, JSON.stringify(oauthMetadata, null, 2));

      // Create Express app with MCP configuration  
      log('INFO', 'Creating Express app for MCP resource server');
      const app = createMcpExpressApp({
        host: this.serverConfig.host
      });
      
      log('INFO', 'Express app created successfully');

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

      // Authentication middleware that validates bearer tokens
      const authenticateBearer = async (req, res, next) => {
        log('DEBUG', 'Authentication attempt', {
          method: req.method,
          path: req.path,
          userAgent: req.get('User-Agent'),
          ip: req.ip,
          hasAuth: !!req.headers.authorization
        });
        
        const authHeader = req.headers.authorization;
      
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          log('WARN', 'Authentication failed - no bearer token', {
            authHeader: authHeader ? 'present but invalid format' : 'missing',
            path: req.path
          });
          
          // Set WWW-Authenticate header for OAuth discovery (MCP spec requirement)
          res.setHeader('WWW-Authenticate', 
            `Bearer realm="mcp", ` +
            `authorization_uri="${oauthMetadata.authorization_endpoint}", ` +
            `client_id="mcp-client", ` +
            `scope="${oauthMetadata.scopes_supported.join(' ')}"`
          );
          return res.status(401).json({
            error: 'unauthorized',
            message: 'Bearer token required'
          });
        }

        const token = authHeader.substring(7); // Remove 'Bearer ' prefix

        try {
          log('DEBUG', 'Attempting token introspection', {
            tokenPrefix: token.substring(0, 8) + '...',
            introspectionEndpoint: oauthMetadata.introspection_endpoint
          });
          
          // Verify token with OAuth server via introspection endpoint
          const introspectResponse = await fetch(oauthMetadata.introspection_endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: `token=${encodeURIComponent(token)}`
          });

        if (!introspectResponse.ok) {
          throw new Error('Token introspection failed');
        }

        const tokenInfo = await introspectResponse.json();
        
        if (!tokenInfo.active) {
          throw new Error('Token is not active');
        }

        req.auth = {
          token,
          clientId: tokenInfo.client_id,
          scopes: tokenInfo.scope ? tokenInfo.scope.split(' ') : [],
          expiresAt: tokenInfo.exp,
          resource: tokenInfo.aud
        };
        next();
      } catch (error) {
        res.setHeader('WWW-Authenticate', 
          `Bearer realm="mcp", ` +
          `error="invalid_token", ` +
          `error_description="${error.message}"`
        );
        return res.status(401).json({
          error: 'invalid_token',
          message: error.message
        });
      }
    };

      // SSE endpoint for MCP communication
      app.get(this.endpoints.mcp.sse, authenticateBearer, async (req, res) => {
        try {
          log('INFO', 'SSE connection attempt', { 
            clientId: req.auth?.clientId,
            userAgent: req.get('User-Agent'),
            ip: req.ip
          });
          
          const transport = new SSEServerTransport(this.endpoints.mcp.message, res);
          await this.server.connect(transport);
          
          log('INFO', 'SSE connection established successfully', {
            clientId: req.auth.clientId
          });
          
          console.error(`🔌 SSE connection established for client: ${req.auth.clientId}`);
        } catch (error) {
          log('ERROR', 'Failed to establish SSE connection', {
            error: error.message,
            stack: error.stack,
            clientId: req.auth?.clientId
          });
          throw error;
        }
      });

    // Message endpoint for MCP requests
    app.post(this.endpoints.mcp.message, authenticateBearer, async (req, res) => {
      // This would be handled by the SSE transport
      // For now, return a simple response
      res.json({ message: 'Use SSE endpoint for MCP communication' });
    });

    // Health endpoint
    app.get(this.endpoints.mcp.health, (req, res) => {
      res.json({
        status: 'ok',
        server: 'remote-mcp-server-spec-compliant',
        oauth: {
          issuer: oauthMetadata.issuer,
          authorization_endpoint: oauthMetadata.authorization_endpoint,
          token_endpoint: oauthMetadata.token_endpoint,
          scopes_supported: oauthMetadata.scopes_supported
        },
        endpoints: {
          sse: `${this.urls.mcpServer}${this.endpoints.mcp.sse}`,
          message: `${this.urls.mcpServer}${this.endpoints.mcp.message}`
        },
        timestamp: new Date().toISOString()
      });
    });

      // Start HTTP server
      log('INFO', 'Starting HTTP server', { port: this.serverConfig.port });
      
      const httpServer = app.listen(this.serverConfig.port, () => {
        log('INFO', 'MCP Resource Server started successfully', {
          port: this.serverConfig.port,
          pid: process.pid
        });
        
        console.error(`🚀 MCP Resource Server running on ${this.serverConfig.host}:${this.serverConfig.port}`);
        console.error(`🎯 SSE Endpoint: ${this.urls.mcpServer}${this.endpoints.mcp.sse}`);
        console.error(`💚 Health: ${this.urls.mcpServer}${this.endpoints.mcp.health}`);
        console.error('');
        console.error('💡 This server implements the MCP Authorization specification:');
        console.error('   https://modelcontextprotocol.io/specification/draft/basic/authorization');
        
        // Log periodic health checks
        setInterval(() => {
          log('DEBUG', 'Server health check', {
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            connections: httpServer.listening ? 'active' : 'inactive'
          });
        }, 30000); // Every 30 seconds
      });

      httpServer.on('error', (error) => {
        log('ERROR', 'HTTP server error', {
          error: error.message,
          code: error.code,
          stack: error.stack
        });
      });

      httpServer.on('close', () => {
        log('INFO', 'HTTP server closed');
      });

    } catch (error) {
      log('ERROR', 'Failed to start server', {
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }
}

// Start the server
log('INFO', 'Creating server instance');
const server = new RemoteMCPServerSpecCompliant();

log('INFO', 'Starting server');
server.run().catch((error) => {
  log('ERROR', 'Server failed to start', {
    error: error.message,
    stack: error.stack
  });
  console.error('💥 Server failed to start:', error);
  process.exit(1);
});