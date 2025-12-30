#!/usr/bin/env node

/**
 * Supabase OAuth MCP Server with HTTP Transport
 * 
 * This server provides MCP (Model Context Protocol) functionality with:
 * - OAuth 2.0 with PKCE authentication
 * - HTTP transport for MCP protocol
 * - User-specific tool execution
 * - Session management and logging
 * - OAuth discovery endpoints
 * - Official MCP SDK integration
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InMemoryEventStore } from '@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js';
import { createSupabaseClient, logToolCall } from '../utils/supabase.js';
import { serverLogger, mcpLogger } from '../utils/logger.js';
import { authMiddleware } from './auth-middleware.js';
import { getAllToolDefinitions, executeTool } from './tools/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

// Configuration constants - MCP compliant
const MCP_SERVER_URL = process.env.MCP_SERVER_URL || (process.env.NODE_ENV === 'production' 
  ? 'https://your-production-domain.com' 
  : 'http://localhost:3007');

// Pre-registered Claude Desktop client (MCP compliant)
const CLAUDE_DESKTOP_CLIENT = {
  client_id: 'claude-desktop',
  client_name: 'Claude Desktop',
  redirect_uris: ['urn:ietf:wg:oauth:2.0:oob'], // Out-of-band for desktop apps
  grant_types: ['authorization_code'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none', // Public client
  scope: 'mcp:tools'
};

// PKCE code storage for validation
const pkceCodes = new Map(); // In production, use Redis or database

/**
 * Main MCP Server class
 */
class SupabaseMCPServer {
  constructor() {
    this.app = express();
    this.port = parseInt(process.env.MCP_SERVER_PORT) || 3007;
    this.host = process.env.MCP_SERVER_HOST || 'localhost';
    this.serverUrl = MCP_SERVER_URL;
    
    // Initialize components
    this.supabase = createSupabaseClient();
    
    // Initialize MCP SDK Server
    this.mcpServer = new McpServer(
      {
        name: 'supabase-mcp-server',
        version: '1.0.0'
      },
      {
        capabilities: {
          tools: {
            listChanged: true
          },
          logging: {}
        }
      }
    );

    // Initialize MCP session management
    this.mcpEventStore = new InMemoryEventStore();
    this.mcpTransports = new Map(); // Track transports by session ID
    
    // Request tracking
    this.requestCount = 0;
    this.startTime = Date.now();
    
    this.setupMCPToolHandlers();
    this.setupMiddleware();
    this.setupRoutes();
    this.setupErrorHandling();
    
    serverLogger.info('Supabase MCP Server initialized with SDK', {
      port: this.port,
      host: this.host,
      environment: process.env.NODE_ENV || 'development'
    });
  }
  
  /**
   * Setup MCP tools using the McpServer API
   */
  setupMCPToolHandlers() {
    // Get all tool definitions from our existing tool registry
    const tools = getAllToolDefinitions();
    
    // Register each tool with the MCP server
    tools.forEach(tool => {
      this.mcpServer.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.inputSchema
        },
        async (args, extra = {}) => {
          // Get authentication context from the transport
          // The transport should have the auth context stored from the session
          const transport = extra.transport || this.mcpTransports.get(extra.sessionId);
          const authContext = transport?._authContext;
          const authenticatedUser = authContext?.user || null;
          const supabaseInstance = authContext?.supabase || this.supabase;

          if (!authenticatedUser) {
            throw new Error('User authentication required for tool calls');
          }

          mcpLogger.info('Tool call via McpServer', { 
            userId: authenticatedUser.id, 
            toolName: tool.name, 
            args 
          });

          const startTime = Date.now();
          
          try {
            const result = await executeTool(tool.name, args || {}, authenticatedUser, supabaseInstance);
            const duration = Date.now() - startTime;
            
            // Log successful tool call
            try {
              await logToolCall(null, authenticatedUser.id, tool.name, args, result, duration, true);
            } catch (logError) {
              serverLogger.warn('Failed to log tool call', { 
                userId: authenticatedUser.id, 
                toolName: tool.name 
              }, logError);
            }
            
            mcpLogger.info('Tool call completed via McpServer', { 
              userId: authenticatedUser.id, 
              toolName: tool.name, 
              duration: `${duration}ms`,
              success: true
            });
            
            return result;
            
          } catch (error) {
            const duration = Date.now() - startTime;
            
            // Log failed tool call
            try {
              await logToolCall(null, authenticatedUser.id, tool.name, args, null, duration, false, error.message);
            } catch (logError) {
              serverLogger.warn('Failed to log tool call error', { 
                userId: authenticatedUser.id, 
                toolName: tool.name 
              }, logError);
            }
            
            mcpLogger.error('Tool call failed via McpServer', { 
              userId: authenticatedUser.id, 
              toolName: tool.name, 
              duration: `${duration}ms`,
              error: error.message
            });
            
            throw error;
          }
        }
      );
    });

    serverLogger.info(`MCP SDK registered ${tools.length} tools: ${tools.map(t => t.name).join(', ')}`);
  }

  /**
   * Get or create MCP transport for a session
   */
  async getOrCreateMCPTransport(sessionId, user) {
    let transport = sessionId ? this.mcpTransports.get(sessionId) : undefined;
    
    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => Date.now().toString() + '-' + Math.random().toString(36).substring(2),
        eventStore: this.mcpEventStore,
        retryInterval: 2000,
        onsessioninitialized: (id) => {
          serverLogger.info('MCP session initialized', { sessionId: id, userId: user.id });
          this.mcpTransports.set(id, transport);
        }
      });
      
      // Store auth context for this transport
      transport._authContext = {
        user: user,
        supabase: this.supabase
      };
      
      // Connect the MCP server to the transport
      await this.mcpServer.connect(transport);
      
      serverLogger.info('Created new MCP transport', { sessionId, userId: user.id });
    }
    
    // Update auth context for existing transport
    transport._authContext = {
      user: user,
      supabase: this.supabase
    };
    
    return transport;
  }
  
  /**
   * Setup Express middleware
   */
  setupMiddleware() {
    // Request tracking
    this.app.use((req, res, next) => {
      this.requestCount++;
      req.requestId = this.requestCount;
      req.startTime = Date.now();
      
      serverLogger.logRequest(req);
      next();
    });
    
    // CORS configuration (MCP compliant - single server URL)
    const corsOrigins = process.env.CORS_ORIGINS 
      ? JSON.parse(process.env.CORS_ORIGINS)
      : [this.serverUrl]; // Use single MCP server URL
    
    serverLogger.info('CORS configuration', { 
      corsOrigins, 
      serverUrl: this.serverUrl 
    });
    
    this.app.use(cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps, Claude Desktop, etc.)
        if (!origin) return callback(null, true);
        
        if (corsOrigins.includes(origin)) {
          serverLogger.debug('✅ CORS origin allowed', { origin });
          callback(null, true);
        } else {
          serverLogger.warn('❌ CORS origin rejected', { 
            origin, 
            allowed: corsOrigins,
            serverUrl: this.serverUrl
          });
          callback(new Error('Not allowed by CORS'));
        }
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization']
    }));
    
    // Body parsing
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));
    
    // Serve static files from web/public
    const staticPath = path.join(__dirname, '..', 'web', 'public');
    this.app.use(express.static(staticPath));
    
    serverLogger.info('Static files served from', { path: staticPath });
    
    // Security headers
    this.app.use((req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.setHeader('X-MCP-Version', '2024-11-05');
      res.setHeader('X-Server-Type', 'Supabase-MCP-HTTP');
      next();
    });
    
    // Response logging
    this.app.use((req, res, next) => {
      const originalSend = res.json;
      res.json = function(data) {
        const duration = Date.now() - req.startTime;
        serverLogger.logResponse(req, res, duration);
        return originalSend.call(this, data);
      };
      next();
    });
  }
  
  /**
   * Setup API routes
   */
  setupRoutes() {
    // Health check (public)
    this.app.get('/health', (req, res) => {
      const uptime = Date.now() - this.startTime;
      
      res.json({
        status: 'healthy',
        service: 'supabase-mcp-server',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        uptime: {
          milliseconds: uptime,
          seconds: Math.floor(uptime / 1000),
          human: this._formatUptime(uptime)
        },
        requests: {
          total: this.requestCount,
          rate: Math.round((this.requestCount / (uptime / 1000)) * 100) / 100
        },
        environment: {
          node_version: process.version,
          platform: process.platform,
          arch: process.arch
        }
      });
    });
    
    // Server info (public)
    this.app.get('/', (req, res) => {
      res.json({
        service: 'Supabase MCP Server',
        version: '1.0.0',
        protocol_version: '2024-11-05',
        transport: 'http',
        authentication: 'oauth2',
        endpoints: {
          mcp: '/mcp',
          health: '/health',
          authorize: '/authorize',
          token: '/token',
          register: '/register'
        },
        features: [
          'HTTP transport',
          'OAuth 2.0 with PKCE',
          'Supabase authentication',
          'User-scoped tool execution',
          'Session management',
          'Tool call logging'
        ],
        timestamp: new Date().toISOString()
      });
    });

    // OAuth 2.0 Discovery endpoints (MCP compliant)
    this.app.get('/.well-known/oauth-authorization-server', (req, res) => {
      serverLogger.info('🔍 OAuth Discovery Request', {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        serverUrl: this.serverUrl,
        timestamp: new Date().toISOString()
      });

      const discovery = {
        issuer: this.serverUrl,
        authorization_endpoint: `${this.serverUrl}/authorize`,
        token_endpoint: `${this.serverUrl}/token`,
        registration_endpoint: `${this.serverUrl}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'], // PKCE required
        scopes_supported: ['mcp:tools'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
        resource_indicators_supported: true, // MCP requirement
        require_request_uri_registration: false,
        request_object_signing_alg_values_supported: ['none'],
        claims_supported: ['sub', 'aud', 'exp', 'iat'],
        subject_types_supported: ['public']
      };

      serverLogger.info('✅ OAuth Discovery Response', { 
        endpoints: {
          authorization: discovery.authorization_endpoint,
          token: discovery.token_endpoint,
          registration: discovery.registration_endpoint
        },
        features: {
          pkce: discovery.code_challenge_methods_supported,
          resource_indicators: discovery.resource_indicators_supported
        }
      });

      res.json(discovery);
    });

    this.app.get('/.well-known/oauth-protected-resource', (req, res) => {
      serverLogger.info('🛡️ Protected Resource Discovery Request', {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        serverUrl: this.serverUrl
      });

      const resourceInfo = {
        resource_server: this.serverUrl,
        authorization_servers: [this.serverUrl],
        scopes_supported: ['mcp:tools'],
        bearer_methods_supported: ['header'],
        resource_documentation: `${this.serverUrl}/docs`
      };

      serverLogger.info('✅ Protected Resource Discovery Response', { 
        resourceServer: resourceInfo.resource_server,
        scopes: resourceInfo.scopes_supported,
        bearerMethods: resourceInfo.bearer_methods_supported
      });

      res.json(resourceInfo);
    });

    // OAuth 2.0 Authorization endpoint (MCP compliant)
    this.app.get('/authorize', (req, res) => {
      const { 
        response_type, 
        client_id, 
        redirect_uri, 
        scope, 
        state, 
        code_challenge, 
        code_challenge_method,
        resource // MCP requirement
      } = req.query;

      serverLogger.info('🔐 OAuth Authorization Request', {
        clientId: client_id,
        redirectUri: redirect_uri,
        scope: scope,
        resource: resource,
        hasCodeChallenge: !!code_challenge,
        codeChallengMethod: code_challenge_method,
        ip: req.ip,
        userAgent: req.get('User-Agent')
      });
      
      // Validate required OAuth parameters
      if (!response_type || response_type !== 'code') {
        serverLogger.warn('❌ Invalid response_type', { response_type });
        return res.status(400).json({
          error: 'unsupported_response_type',
          error_description: 'Only "code" response type is supported'
        });
      }

      if (!client_id || !redirect_uri) {
        serverLogger.warn('❌ Missing required parameters', { client_id: !!client_id, redirect_uri: !!redirect_uri });
        return res.status(400).json({
          error: 'invalid_request',
          error_description: 'Missing required parameters: client_id or redirect_uri'
        });
      }

      // MCP compliance: Validate resource parameter
      if (resource && resource !== this.serverUrl) {
        serverLogger.warn('❌ Invalid resource parameter', { 
          provided: resource, 
          expected: this.serverUrl 
        });
        return res.status(400).json({
          error: 'invalid_request',
          error_description: 'Invalid resource parameter'
        });
      }

      // PKCE validation for public clients (required for MCP)
      if (!code_challenge || !code_challenge_method) {
        serverLogger.warn('❌ Missing PKCE parameters', { 
          hasCodeChallenge: !!code_challenge, 
          method: code_challenge_method 
        });
        return res.status(400).json({
          error: 'invalid_request',
          error_description: 'PKCE is required (code_challenge and code_challenge_method)'
        });
      }

      if (code_challenge_method !== 'S256') {
        serverLogger.warn('❌ Invalid PKCE method', { method: code_challenge_method });
        return res.status(400).json({
          error: 'invalid_request',
          error_description: 'Only S256 code_challenge_method is supported'
        });
      }

      // Store PKCE code challenge for later validation
      const authorizationId = Date.now().toString() + '-' + Math.random().toString(36).substring(2);
      pkceCodes.set(authorizationId, {
        code_challenge,
        code_challenge_method,
        client_id,
        redirect_uri,
        scope: scope || 'mcp:tools',
        resource: resource || this.serverUrl,
        created_at: Date.now()
      });

      // Clean up old PKCE codes (older than 10 minutes)
      const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
      for (const [id, data] of pkceCodes) {
        if (data.created_at < tenMinutesAgo) {
          pkceCodes.delete(id);
        }
      }

      // Redirect to Supabase authentication page
      const authUrl = `${this.serverUrl}/auth.html?${new URLSearchParams({
        response_type,
        client_id,
        redirect_uri,
        scope: scope || 'mcp:tools',
        state: state || '',
        code_challenge,
        code_challenge_method,
        resource: resource || this.serverUrl,
        auth_id: authorizationId // Include for PKCE validation
      }).toString()}`;
      
      serverLogger.info('✅ Redirecting to authentication page', { 
        authUrl: authUrl.substring(0, 100) + '...', // Truncate for logging
        authorizationId,
        clientId: client_id
      });
      
      res.redirect(authUrl);
    });

    // OAuth 2.0 Token endpoint (MCP compliant)
    this.app.post('/token', express.json(), async (req, res) => {
      try {
        const { 
          grant_type, 
          code, 
          redirect_uri, 
          client_id, 
          code_verifier, 
          resource // MCP requirement
        } = req.body;

        serverLogger.info('🎟️ Token Exchange Request', {
          grantType: grant_type,
          clientId: client_id,
          redirectUri: redirect_uri,
          resource: resource,
          hasCode: !!code,
          hasCodeVerifier: !!code_verifier,
          ip: req.ip
        });
        
        if (grant_type === 'authorization_code') {
          // Validate required parameters
          if (!code || !redirect_uri || !client_id) {
            serverLogger.warn('❌ Missing token request parameters', {
              hasCode: !!code,
              hasRedirectUri: !!redirect_uri, 
              hasClientId: !!client_id
            });
            return res.status(400).json({
              error: 'invalid_request',
              error_description: 'Missing required parameters: code, redirect_uri, or client_id'
            });
          }

          // PKCE validation (required for MCP)
          if (!code_verifier) {
            serverLogger.warn('❌ Missing PKCE code_verifier', { clientId: client_id });
            return res.status(400).json({
              error: 'invalid_request',
              error_description: 'code_verifier is required for PKCE'
            });
          }

          // Find and validate PKCE challenge
          let pkceData = null;
          let authorizationId = null;
          
          for (const [id, data] of pkceCodes) {
            if (data.client_id === client_id && data.redirect_uri === redirect_uri) {
              pkceData = data;
              authorizationId = id;
              break;
            }
          }

          if (!pkceData) {
            serverLogger.warn('❌ No PKCE data found', { 
              clientId: client_id,
              redirectUri: redirect_uri 
            });
            return res.status(400).json({
              error: 'invalid_grant',
              error_description: 'Invalid authorization code or expired PKCE challenge'
            });
          }

          // Validate PKCE code_verifier against code_challenge
          const crypto = await import('crypto');
          const hash = crypto.createHash('sha256').update(code_verifier).digest();
          const computedChallenge = hash.toString('base64url');
          
          if (computedChallenge !== pkceData.code_challenge) {
            serverLogger.warn('❌ PKCE validation failed', {
              clientId: client_id,
              expectedChallenge: pkceData.code_challenge.substring(0, 10) + '...',
              computedChallenge: computedChallenge.substring(0, 10) + '...'
            });
            pkceCodes.delete(authorizationId); // Clean up
            return res.status(400).json({
              error: 'invalid_grant',
              error_description: 'PKCE validation failed'
            });
          }

          // MCP compliance: Validate resource parameter
          if (resource && resource !== this.serverUrl) {
            serverLogger.warn('❌ Invalid resource in token request', {
              provided: resource,
              expected: this.serverUrl
            });
            return res.status(400).json({
              error: 'invalid_request',
              error_description: 'Invalid resource parameter'
            });
          }

          // Clean up PKCE data
          pkceCodes.delete(authorizationId);

          // Use the authorization code as access token (from Supabase callback)
          const accessToken = code;
          
          try {
            const { data: { user }, error: userError } = await this.supabase.auth.getUser(accessToken);
            
            if (userError) {
              serverLogger.warn('❌ Token validation failed', {
                error: userError.message,
                clientId: client_id
              });
              return res.status(400).json({
                error: 'invalid_grant',
                error_description: 'Invalid authorization code'
              });
            }

            const tokenResponse = {
              access_token: accessToken,
              token_type: 'Bearer',
              expires_in: 86400, // 24 hours
              scope: pkceData.scope,
              resource: pkceData.resource // MCP compliance
            };

            serverLogger.info('✅ Token exchange successful', {
              userId: user.id,
              email: user.email,
              clientId: client_id,
              scope: tokenResponse.scope,
              resource: tokenResponse.resource
            });

            res.json(tokenResponse);
            
          } catch (error) {
            serverLogger.error('❌ Token validation error', { clientId: client_id }, error);
            res.status(500).json({
              error: 'server_error',
              error_description: 'Failed to validate token'
            });
          }
        } else {
          serverLogger.warn('❌ Unsupported grant type', { grantType: grant_type });
          res.status(400).json({
            error: 'unsupported_grant_type',
            error_description: 'Only authorization_code grant type is supported'
          });
        }
      } catch (error) {
        serverLogger.error('❌ Token endpoint error', null, error);
        res.status(500).json({
          error: 'server_error',
          error_description: 'Internal server error'
        });
      }
    });

    // OAuth 2.0 Client Registration endpoint
    this.app.post('/register', express.json(), (req, res) => {
      const { client_name, redirect_uris, scope } = req.body;
      
      serverLogger.info('📝 Client Registration Request', {
        clientName: client_name,
        redirectUris: redirect_uris,
        scope: scope,
        ip: req.ip
      });

      if (!client_name || !redirect_uris) {
        serverLogger.warn('❌ Invalid client registration request', {
          hasClientName: !!client_name,
          hasRedirectUris: !!redirect_uris
        });
        return res.status(400).json({
          error: 'invalid_client_metadata',
          error_description: 'Missing required parameters: client_name or redirect_uris'
        });
      }

      // Check if requesting pre-registered Claude Desktop client
      if (client_name === 'Claude Desktop' || client_name === CLAUDE_DESKTOP_CLIENT.client_name) {
        serverLogger.info('✅ Returning pre-registered Claude Desktop client', {
          clientId: CLAUDE_DESKTOP_CLIENT.client_id
        });
        
        return res.json({
          ...CLAUDE_DESKTOP_CLIENT,
          redirect_uris: CLAUDE_DESKTOP_CLIENT.redirect_uris,
          client_id_issued_at: Math.floor(Date.now() / 1000),
          client_secret_expires_at: 0 // Never expires for public client
        });
      }

      // Generate client credentials for dynamic registration
      const clientId = 'mcp_' + Date.now() + '_' + Math.random().toString(36).substring(2);
      const clientSecret = 'secret_' + Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);

      const clientInfo = {
        client_id: clientId,
        client_secret: clientSecret,
        client_name: client_name,
        redirect_uris: Array.isArray(redirect_uris) ? redirect_uris : [redirect_uris],
        scope: scope || 'mcp:tools',
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_secret_expires_at: 0 // Never expires
      };

      serverLogger.info('✅ Dynamic client registration successful', {
        clientId: clientInfo.client_id,
        clientName: clientInfo.client_name,
        redirectUris: clientInfo.redirect_uris
      });

      res.json(clientInfo);
    });

    // MCP endpoint (authenticated) - using SDK (supports both GET and POST)
    this.app.all('/mcp',
      authMiddleware.validate,
      authMiddleware.rateLimit(100, 60000), // 100 requests per minute
      this.handleMCPMessageWithSDK.bind(this)
    );

    // Direct MCP endpoint without auth (for HTTP transport)
    this.app.all('/mcp-direct', 
      express.json(),
      authMiddleware.rateLimit(100, 60000),
      async (req, res) => {
        // Handle direct MCP calls with Bearer token
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return res.status(401).json({
            jsonrpc: '2.0',
            id: req.body?.id || null,
            error: {
              code: -32001,
              message: 'Missing or invalid authorization header'
            }
          });
        }

        const accessToken = authHeader.split(' ')[1];
        try {
          const { data: { user }, error: userError } = await this.supabase.auth.getUser(accessToken);
          
          if (userError) {
            return res.status(401).json({
              jsonrpc: '2.0',
              id: req.body?.id || null,
              error: {
                code: -32001,
                message: 'Invalid access token'
              }
            });
          }

          req.user = user;
          await this.handleMCPMessageWithSDK(req, res);
          
        } catch (error) {
          serverLogger.error('Direct MCP auth error', null, error);
          res.status(500).json({
            jsonrpc: '2.0',
            id: req.body?.id || null,
            error: {
              code: -32603,
              message: 'Internal error'
            }
          });
        }
      }
    );
    
    // Tools discovery (authenticated) - using McpServer
    this.app.get('/tools',
      authMiddleware.validate,
      async (req, res) => {
        try {
          // Use the existing tool definitions directly since they're already registered
          const tools = getAllToolDefinitions();
          
          res.json({
            tools: tools,
            count: tools.length,
            user_id: req.user.id
          });
        } catch (error) {
          res.status(500).json({
            error: 'Failed to retrieve tools',
            message: error.message
          });
        }
      }
    );
    
    // OAuth callback handler
    this.app.get('/auth/callback', async (req, res) => {
      const { 
        access_token, 
        refresh_token, 
        error, 
        error_description, 
        client_id, 
        redirect_uri, 
        state,
        auth_id // For PKCE validation
      } = req.query;

      serverLogger.info('🔄 OAuth Callback Received', {
        hasAccessToken: !!access_token,
        hasRefreshToken: !!refresh_token,
        error: error,
        clientId: client_id,
        redirectUri: redirect_uri,
        state: state,
        authId: auth_id,
        ip: req.ip
      });
      
      if (error) {
        serverLogger.warn('OAuth callback error', { error, error_description });
        
        if (redirect_uri) {
          const errorUrl = new URL(redirect_uri);
          errorUrl.searchParams.set('error', error);
          if (error_description) errorUrl.searchParams.set('error_description', error_description);
          if (state) errorUrl.searchParams.set('state', state);
          return res.redirect(errorUrl.toString());
        }

        return res.status(400).json({ error, error_description });
      }
      
      if (access_token) {
        try {
          // Verify the Supabase token
          const { data: { user }, error: userError } = await this.supabase.auth.getUser(access_token);
          
          if (userError) {
            throw new Error(`Token validation failed: ${userError.message}`);
          }
          
          serverLogger.info('OAuth callback successful', { 
            userId: user.id, 
            email: user.email, 
            client_id 
          });
          
          // Store session
          const { error: sessionError } = await this.supabase
            .from('mcp_sessions')
            .insert({
              user_id: user.id,
              session_token: access_token,
              client_info: { client_id },
              expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
            });
          
          if (sessionError) {
            serverLogger.warn('Failed to store session', { userId: user.id }, sessionError);
          }
          
          // Redirect back to client with authorization code (using access_token as code)
          if (redirect_uri) {
            const successUrl = new URL(redirect_uri);
            successUrl.searchParams.set('code', access_token); // Use access_token as authorization code
            if (state) successUrl.searchParams.set('state', state);
            return res.redirect(successUrl.toString());
          }

          res.json({ access_token, token_type: 'Bearer', expires_in: 86400 });
          
        } catch (error) {
          serverLogger.error('OAuth callback processing failed', null, error);
          
          if (redirect_uri) {
            const errorUrl = new URL(redirect_uri);
            errorUrl.searchParams.set('error', 'invalid_token');
            errorUrl.searchParams.set('error_description', error.message);
            if (state) errorUrl.searchParams.set('state', state);
            return res.redirect(errorUrl.toString());
          }

          res.status(400).json({
            error: 'invalid_token',
            error_description: error.message
          });
        }
      } else {
        const error_msg = 'No access token received';
        
        if (redirect_uri) {
          const errorUrl = new URL(redirect_uri);
          errorUrl.searchParams.set('error', 'access_denied');
          errorUrl.searchParams.set('error_description', error_msg);
          if (state) errorUrl.searchParams.set('state', state);
          return res.redirect(errorUrl.toString());
        }

        res.status(400).json({
          error: 'access_denied',
          error_description: error_msg
        });
      }
    });
    
    // MCP info API endpoint for web interface
    this.app.get('/api/mcp-info', (req, res) => {
      serverLogger.info('ℹ️ MCP Info Request', {
        ip: req.ip,
        userAgent: req.get('User-Agent')
      });

      const mcpInfo = {
        mcpServerUrl: this.serverUrl,
        supabaseUrl: process.env.SUPABASE_URL,
        supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
        redirectUrl: `${this.serverUrl}/auth/callback`,
        authorizationEndpoint: `${this.serverUrl}/authorize`,
        tokenEndpoint: `${this.serverUrl}/token`,
        discoveryEndpoint: `${this.serverUrl}/.well-known/oauth-authorization-server`
      };

      serverLogger.info('✅ MCP Info Response', {
        mcpServerUrl: mcpInfo.mcpServerUrl,
        redirectUrl: mcpInfo.redirectUrl,
        hasSupabaseConfig: !!(mcpInfo.supabaseUrl && mcpInfo.supabaseAnonKey)
      });

      res.json(mcpInfo);
    });
  }
  
  /**
   * Handle MCP protocol messages using session-based transports
   */
  async handleMCPMessageWithSDK(req, res) {
    const startTime = Date.now();
    const userId = req.user.id;
    
    try {
      const requestBody = req.body;
      const sessionId = req.headers['mcp-session-id'];
      
      mcpLogger.logMCPMessage(userId, requestBody?.method, requestBody?.id, 'RECEIVED');
      
      // Get or create transport for this session
      const transport = await this.getOrCreateMCPTransport(sessionId, req.user);
      
      // Handle the request using the session transport
      await transport.handleRequest(req, res, requestBody);
      
      const duration = Date.now() - startTime;
      mcpLogger.logMCPMessage(userId, requestBody?.method, requestBody?.id, 'RESPONDED');
      mcpLogger.info('MCP SDK request completed', {
        userId,
        sessionId,
        method: requestBody?.method,
        duration: `${duration}ms`
      });
      
    } catch (error) {
      const duration = Date.now() - startTime;
      
      // Only send error response if headers haven't been sent yet
      if (!res.headersSent) {
        const errorResponse = {
          jsonrpc: '2.0',
          id: req.body?.id || null,
          error: {
            code: this._getErrorCode(error),
            message: error.message,
            data: process.env.DEBUG_MODE === 'true' ? error.stack : undefined
          }
        };
        
        mcpLogger.error('MCP SDK request failed', {
          userId,
          method: req.body?.method,
          duration: `${duration}ms`,
          error: error.message
        });
        
        res.status(400).json(errorResponse);
      } else {
        mcpLogger.error('MCP SDK request failed (headers already sent)', {
          userId,
          method: req.body?.method,
          duration: `${duration}ms`,
          error: error.message
        });
      }
    }
  }
  
  /**
   * Get JSON-RPC error code for different error types
   */
  _getErrorCode(error) {
    if (error.message.includes('Unknown method')) return -32601;
    if (error.message.includes('Invalid Request')) return -32600;
    if (error.message.includes('Parse error')) return -32700;
    if (error.message.includes('Invalid params')) return -32602;
    return -32603; // Internal error
  }
  
  /**
   * Format uptime in human readable format
   */
  _formatUptime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }
  
  /**
   * Setup error handling
   */
  setupErrorHandling() {
    // 404 handler
    this.app.use((req, res) => {
      serverLogger.warn('Route not found', { 
        method: req.method, 
        url: req.url, 
        ip: req.ip 
      });
      
      res.status(404).json({
        error: 'Not Found',
        message: `Route ${req.method} ${req.url} not found`,
        available_endpoints: [
          'GET /',
          'GET /health',
          'GET /sse (authenticated)',
          'POST /mcp (authenticated)',
          'GET /tools (authenticated)',
          'GET /stats (authenticated)'
        ]
      });
    });
    
    // Error handler
    this.app.use((error, req, res, next) => {
      const duration = Date.now() - (req.startTime || Date.now());
      
      serverLogger.error('Express error handler', {
        method: req.method,
        url: req.url,
        ip: req.ip,
        duration: `${duration}ms`,
        userId: req.user?.id
      }, error);
      
      // CORS errors
      if (error.message.includes('CORS')) {
        return res.status(403).json({
          error: 'CORS Error',
          message: 'Origin not allowed'
        });
      }
      
      // Generic error response
      res.status(error.status || 500).json({
        error: 'Internal Server Error',
        message: process.env.DEBUG_MODE === 'true' ? error.message : 'An unexpected error occurred',
        request_id: req.requestId
      });
    });
    
    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      serverLogger.error('Uncaught exception', null, error);
      this.shutdown();
    });
    
    process.on('unhandledRejection', (reason, promise) => {
      serverLogger.error('Unhandled rejection', { promise }, new Error(reason));
      this.shutdown();
    });
    
    // Handle shutdown signals
    process.on('SIGINT', () => {
      serverLogger.info('Received SIGINT, shutting down gracefully');
      this.shutdown();
    });
    
    process.on('SIGTERM', () => {
      serverLogger.info('Received SIGTERM, shutting down gracefully');
      this.shutdown();
    });
  }
  
  /**
   * Start the server
   */
  async start() {
    return new Promise((resolve, reject) => {
      const server = this.app.listen(this.port, this.host, (error) => {
        if (error) {
          serverLogger.error('Failed to start server', { port: this.port, host: this.host }, error);
          return reject(error);
        }
        
        serverLogger.info('🚀 Supabase MCP Server started', {
          server: `http://${this.host}:${this.port}`,
          health: `http://${this.host}:${this.port}/health`,
          sse: `http://${this.host}:${this.port}/sse`,
          mcp: `http://${this.host}:${this.port}/mcp`,
          environment: process.env.NODE_ENV || 'development'
        });
        
        this.server = server;
        resolve(server);
      });
      
      server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
          serverLogger.error(`Port ${this.port} is already in use`);
        } else {
          serverLogger.error('Server error', null, error);
        }
        reject(error);
      });
    });
  }
  
  /**
   * Graceful shutdown
   */
  async shutdown() {
    serverLogger.info('Starting graceful shutdown...');
    
    try {
      // Close HTTP server
      if (this.server) {
        await new Promise((resolve) => {
          this.server.close(resolve);
        });
      }
      
      serverLogger.info('✅ Graceful shutdown completed');
      process.exit(0);
    } catch (error) {
      serverLogger.error('Error during shutdown', null, error);
      process.exit(1);
    }
  }
}

// Start server if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new SupabaseMCPServer();
  server.start().catch((error) => {
    console.error('Failed to start Supabase MCP Server:', error);
    process.exit(1);
  });
}

export default SupabaseMCPServer;