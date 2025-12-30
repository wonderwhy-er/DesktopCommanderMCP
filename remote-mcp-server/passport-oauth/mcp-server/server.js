#!/usr/bin/env node

/**
 * MCP OAuth-Compliant Server
 * Provides MCP protocol with OAuth 2.1 Bearer token authentication
 */

// Load environment variables
import 'dotenv/config';

import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

const { createCachedTokenValidator } = require('./middleware/oauth.cjs');
const { SSEConnectionManager } = require('./middleware/sse.cjs');

// Import route handlers
const { setupSSERoutes } = require('./routes/sse.cjs');
const { setupMessageRoutes } = require('./routes/message.cjs');
const { setupHealthRoutes } = require('./routes/health.cjs');

class MCPOAuthServer {
  constructor() {
    this.app = express();
    this.port = parseInt(process.env.MCP_PORT) || 3006;
    this.host = process.env.MCP_HOST || 'localhost';
    
    // OAuth configuration
    this.oauthServerUrl = process.env.OAUTH_BASE_URL || 'http://localhost:4449';
    this.introspectionUrl = `http://localhost:${this.port}/introspect`; // Use local introspection
    
    // Initialize token storage
    this.authCodes = new Map(); // Store authorization codes temporarily
    this.accessTokens = new Map(); // Store access tokens
    
    // Initialize SSE connection manager
    this.connectionManager = new SSEConnectionManager();
    
    // Create cached token validator using local introspection
    this.tokenValidator = createCachedTokenValidator(this.introspectionUrl, 60000);
    
    this.setupMiddleware();
    this.setupRoutes();
    this.setupErrorHandling();
  }

  setupMiddleware() {
    // CORS configuration
    this.app.use(cors({
      origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        
        // In demo mode, allow all origins
        if (process.env.DEMO_MODE === 'true') {
          return callback(null, true);
        }
        
        // Define allowed origins for production
        const allowedOrigins = [
          'http://localhost:3002',
          'http://localhost:3003',
          'http://localhost:4449',
          'http://localhost:8847',
          'http://localhost:8848'
        ];
        
        if (allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Origin',
        'X-Requested-With',
        'Content-Type',
        'Accept',
        'Authorization'
      ]
    }));

    // Parse JSON and URL-encoded bodies
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Security headers
    this.app.use((req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      
      // MCP-specific headers
      res.setHeader('X-MCP-Version', '2024-11-05');
      res.setHeader('X-OAuth-Required', 'true');
      
      next();
    });

    // Comprehensive Request/Response logging
    this.app.use((req, res, next) => {
      const timestamp = new Date().toISOString();
      const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      const startTime = Date.now();
      
      // Attach request ID to request for tracking
      req.requestId = requestId;
      
      // Log incoming request
      console.log(`\n🔵 [${timestamp}] INCOMING REQUEST [${requestId}]`);
      console.log(`📍 ${req.method} ${req.url}`);
      console.log(`🌐 Client: ${req.ip}`);
      console.log(`📱 User-Agent: ${req.headers['user-agent'] || 'unknown'}`);
      
      // Log request headers (filtered for security)
      const safeHeaders = { ...req.headers };
      if (safeHeaders.authorization) {
        safeHeaders.authorization = safeHeaders.authorization.startsWith('Bearer ') 
          ? `Bearer ***${safeHeaders.authorization.slice(-8)}` 
          : '***hidden***';
      }
      console.log(`📋 Headers:`, JSON.stringify(safeHeaders, null, 2));
      
      // Log request body (for non-GET requests)
      if (req.method !== 'GET' && req.body && Object.keys(req.body).length > 0) {
        const safeBody = { ...req.body };
        // Hide sensitive fields
        ['password', 'client_secret', 'access_token', 'refresh_token'].forEach(field => {
          if (safeBody[field]) safeBody[field] = '***hidden***';
        });
        console.log(`📝 Body:`, JSON.stringify(safeBody, null, 2));
      }
      
      // Log query parameters
      if (Object.keys(req.query).length > 0) {
        const safeQuery = { ...req.query };
        ['access_token', 'token'].forEach(field => {
          if (safeQuery[field]) safeQuery[field] = '***hidden***';
        });
        console.log(`🔍 Query:`, JSON.stringify(safeQuery, null, 2));
      }

      // Capture response data
      const originalSend = res.send;
      const originalJson = res.json;
      let responseBody = null;
      let responseType = 'unknown';

      // Override res.send
      res.send = function(data) {
        responseBody = data;
        responseType = 'send';
        return originalSend.call(this, data);
      };

      // Override res.json
      res.json = function(data) {
        responseBody = data;
        responseType = 'json';
        return originalJson.call(this, data);
      };

      // Log response when finished
      res.on('finish', () => {
        const endTime = Date.now();
        const duration = endTime - startTime;
        const statusCode = res.statusCode;
        const statusEmoji = statusCode >= 400 ? '🔴' : statusCode >= 300 ? '🟡' : '🟢';
        
        console.log(`\n${statusEmoji} [${new Date().toISOString()}] RESPONSE [${requestId}]`);
        console.log(`📊 Status: ${statusCode} ${res.statusMessage || ''}`);
        console.log(`⏱️  Duration: ${duration}ms`);
        
        // Log response headers
        const responseHeaders = res.getHeaders();
        if (Object.keys(responseHeaders).length > 0) {
          console.log(`📤 Response Headers:`, JSON.stringify(responseHeaders, null, 2));
        }
        
        // Log response body (with size limit and JSON formatting)
        if (responseBody !== null) {
          try {
            const bodyString = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody);
            const bodySize = Buffer.byteLength(bodyString, 'utf8');
            
            console.log(`📦 Response Type: ${responseType}`);
            console.log(`📏 Response Size: ${bodySize} bytes`);
            
            // Limit response body logging to avoid huge logs
            if (bodySize > 2000) {
              const truncated = bodyString.substring(0, 2000) + '...[truncated]';
              console.log(`📄 Response Body (truncated):`, truncated);
            } else {
              // Try to pretty-print JSON
              if (responseType === 'json' && typeof responseBody === 'object') {
                console.log(`📄 Response Body:`, JSON.stringify(responseBody, null, 2));
              } else {
                console.log(`📄 Response Body:`, bodyString);
              }
            }
          } catch (error) {
            console.log(`📄 Response Body: [Could not serialize response]`);
          }
        } else {
          console.log(`📄 Response Body: [No body]`);
        }
        
        console.log(`─────────────────────────────────────────────────────────────`);
      });

      // Handle errors
      res.on('error', (error) => {
        const endTime = Date.now();
        const duration = endTime - startTime;
        
        console.log(`\n🔴 [${new Date().toISOString()}] ERROR [${requestId}]`);
        console.log(`❌ Error: ${error.message}`);
        console.log(`⏱️  Duration: ${duration}ms`);
        console.log(`🔍 Error Details:`, error);
        console.log(`─────────────────────────────────────────────────────────────`);
      });

      next();
    });

    // Apply OAuth validation to protected routes
    this.app.use('/sse', this.tokenValidator);
    this.app.use('/message', this.tokenValidator);
    this.app.use('/tools', this.tokenValidator);
    this.app.use('/execute', this.tokenValidator);
  }

  setupRoutes() {
    // Root endpoint
    this.app.get('/', (req, res) => {
      const baseUrl = `https://${req.get('host')}`;
      
      res.json({
        service: 'MCP OAuth Server',
        version: '1.0.0',
        protocol_version: '2024-11-05',
        oauth_required: true,
        oauth: {
          authorization_endpoint: `${baseUrl}/authorize`,
          token_endpoint: `${baseUrl}/token`,
          registration_endpoint: `${baseUrl}/register`,
          introspection_endpoint: `${baseUrl}/introspect`,
          scopes: ['mcp:tools', 'mcp:admin'],
          methods: ['client_secret_post'],
          pkce_required: true
        },
        endpoints: {
          sse: '/sse',
          message: '/message',
          tools: '/tools',
          execute: '/execute',
          health: '/health'
        },
        capabilities: {
          transport: ['sse', 'http'],
          authentication: ['oauth2_bearer'],
          tools: true,
          resources: false,
          prompts: false,
          logging: true
        },
        timestamp: new Date().toISOString()
      });
    });

    // Root POST endpoint for Claude Desktop MCP compatibility
    // Claude Desktop sends MCP messages to POST / instead of POST /message
    this.app.post('/',
      this.tokenValidator,
      require('./middleware/oauth.cjs').requireScope(['mcp:tools']),
      async (req, res) => {
        try {
          const { client_id, user_id } = req.oauth;
          const mcpRequest = req.body;
          
          console.log(`🔵 [${new Date().toISOString()}] MCP message at root endpoint from client ${client_id}:`, JSON.stringify(mcpRequest, null, 2));
          
          // Validate JSON-RPC format
          if (!mcpRequest.jsonrpc || !mcpRequest.method) {
            return res.status(400).json({
              jsonrpc: '2.0',
              id: mcpRequest.id || null,
              error: {
                code: -32600,
                message: 'Invalid Request',
                data: 'Missing required fields: jsonrpc, method'
              }
            });
          }
          
          // Handle locally - use the same logic as message.cjs
          const response = await this.handleMCPRequestLocally(mcpRequest, req.oauth);
          res.json(response);
          
        } catch (error) {
          console.error('❌ Root MCP message handling error:', error);
          res.status(500).json({
            jsonrpc: '2.0',
            id: req.body?.id || null,
            error: {
              code: -32603,
              message: 'Internal error',
              data: error.message
            }
          });
        }
      }
    );

    // Setup route handlers
    this.app.use('/', setupHealthRoutes(this.connectionManager));
    this.app.use('/', setupSSERoutes(this.connectionManager));
    this.app.use('/', setupMessageRoutes(this.connectionManager));

    // MCP specification metadata endpoint
    this.app.get('/.well-known/mcp-server', (req, res) => {
      res.json({
        version: '2024-11-05',
        server: {
          name: 'mcp-oauth-server',
          version: '1.0.0'
        },
        capabilities: {
          tools: {},
          logging: {}
        },
        authentication: {
          type: 'oauth2',
          authorization_server: this.oauthServerUrl,
          token_endpoint: `${this.oauthServerUrl}/token`,
          introspection_endpoint: `${this.oauthServerUrl}/introspect`,
          scopes_supported: ['mcp:tools', 'mcp:admin'],
          token_types_supported: ['Bearer']
        },
        transport: {
          sse: {
            endpoint: '/sse',
            authentication_required: true
          },
          http: {
            endpoint: '/message',
            authentication_required: true
          }
        }
      });
    });

    // OAuth discovery endpoint for MCP clients
    this.app.get('/oauth/discovery', (req, res) => {
      res.json({
        authorization_server: this.oauthServerUrl,
        authorization_endpoint: `${this.oauthServerUrl}/authorize`,
        token_endpoint: `${this.oauthServerUrl}/token`,
        registration_endpoint: `${this.oauthServerUrl}/register`,
        introspection_endpoint: `${this.oauthServerUrl}/introspect`,
        revocation_endpoint: `${this.oauthServerUrl}/revoke`,
        scopes_supported: ['openid', 'email', 'profile', 'mcp:tools', 'mcp:admin'],
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
        code_challenge_methods_supported: ['S256'],
        pkce_required: true
      });
    });

    // OAuth Protected Resource Metadata endpoint (RFC 8705)
    this.app.get('/.well-known/oauth-protected-resource', (req, res) => {
      // Use tunnel URL if available, otherwise fallback to local
      const baseUrl = `https://${req.get('host')}`;
      
      console.log(`🔍 [${new Date().toISOString()}] OAuth protected resource metadata requested`);
      
      const metadata = {
        // Resource server identity
        resource: baseUrl,
        authorization_servers: [`https://${req.get('host')}`],
        
        // Supported scopes for this resource
        scopes_supported: [
          'mcp:tools',
          'mcp:admin',
          'openid',
          'profile',
          'email'
        ],
        
        // Bearer token methods supported
        bearer_methods_supported: [
          'header'  // Authorization: Bearer <token>
        ],
        
        // MCP-specific metadata
        mcp_specification_version: '2024-11-05',
        mcp_server_info: {
          name: 'mcp-server-oauth',
          version: '1.0.0'
        },
        
        // Supported MCP transports
        mcp_transports: [
          {
            type: 'sse',
            endpoint: '/sse',
            authentication_required: true
          },
          {
            type: 'http',
            endpoint: '/message', 
            authentication_required: true
          }
        ],
        
        // Resource capabilities
        capabilities: [
          'tools',
          'logging',
          'sse'
        ]
      };
      
      res.json(metadata);
    });

    // Dynamic Client Registration - Return default client credentials
    this.app.post('/register', async (req, res) => {
      try {
        console.log(`📝 [${new Date().toISOString()}] Dynamic client registration request`);
        console.log('Registration data:', JSON.stringify(req.body, null, 2));
        
        // Return the default client credentials from environment
        const defaultClientId = process.env.DEFAULT_CLIENT_ID || 'mcp-client';
        const defaultClientSecret = process.env.DEFAULT_CLIENT_SECRET || 'mcp-secret-change-in-production';
        const defaultRedirectUri = process.env.DEFAULT_REDIRECT_URI || 'http://localhost:8847/callback';
        const defaultScopes = process.env.DEFAULT_SCOPES || 'openid email profile mcp:tools';
        
        const result = {
          client_id: defaultClientId,
          client_secret: defaultClientSecret,
          client_id_issued_at: Math.floor(Date.now() / 1000),
          client_name: req.body.client_name || 'MCP Client',
          redirect_uris: req.body.redirect_uris || [defaultRedirectUri],
          scope: defaultScopes,
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'client_secret_post',
          application_type: 'web'
        };
        
        console.log('✅ Returning default client credentials:', defaultClientId);
        res.status(201).json(result);
        
      } catch (error) {
        console.error('❌ Dynamic client registration error:', error);
        
        res.status(500).json({
          error: 'server_error',
          error_description: 'Client registration failed',
          details: error.message
        });
      }
    });

    // OAuth Authorization - Show login form
    this.app.get('/authorize', (req, res) => {
      console.log(`🔗 [${new Date().toISOString()}] OAuth authorization request - showing login form`);
      console.log('Authorization params:', JSON.stringify(req.query, null, 2));
      
      const { response_type, client_id, redirect_uri, scope, code_challenge, code_challenge_method, state } = req.query;
      
      // Validate required OAuth parameters
      if (!response_type || !client_id || !redirect_uri) {
        return res.status(400).send(`
          <!DOCTYPE html>
          <html>
          <head><title>OAuth Error</title></head>
          <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
            <h1>❌ Invalid OAuth Request</h1>
            <p>Missing required parameters: response_type, client_id, or redirect_uri</p>
            <a href="/">← Back to Home</a>
          </body>
          </html>
        `);
      }
      
      // Show login form
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>MCP OAuth - Sign In</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              max-width: 400px;
              margin: 50px auto;
              padding: 20px;
              background-color: #f5f5f5;
            }
            .login-container {
              background: white;
              padding: 30px;
              border-radius: 8px;
              box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            }
            .form-group {
              margin-bottom: 20px;
            }
            label {
              display: block;
              margin-bottom: 5px;
              font-weight: 500;
              color: #333;
            }
            input[type="email"], input[type="password"] {
              width: 100%;
              padding: 12px;
              border: 1px solid #ddd;
              border-radius: 4px;
              font-size: 14px;
              box-sizing: border-box;
            }
            .btn {
              width: 100%;
              padding: 12px;
              background: #007cba;
              color: white;
              border: none;
              border-radius: 4px;
              font-size: 16px;
              cursor: pointer;
              font-weight: 500;
            }
            .btn:hover {
              background: #005a87;
            }
            .oauth-info {
              background: #f8f9fa;
              padding: 15px;
              border-radius: 4px;
              margin-bottom: 20px;
              font-size: 14px;
              color: #6c757d;
            }
            .error {
              background: #f8d7da;
              color: #721c24;
              padding: 10px;
              border-radius: 4px;
              margin-bottom: 15px;
              font-size: 14px;
            }
            .demo-credentials {
              background: #d4edda;
              color: #155724;
              padding: 10px;
              border-radius: 4px;
              margin-bottom: 15px;
              font-size: 14px;
            }
          </style>
        </head>
        <body>
          <div class="login-container">
            <h1 style="text-align: center; margin-bottom: 30px; color: #333;">🔐 MCP OAuth</h1>
            
            <div class="oauth-info">
              <strong>Application:</strong> ${client_id}<br>
              <strong>Scopes:</strong> ${scope || 'mcp:tools'}<br>
              <strong>Redirect:</strong> ${redirect_uri}
            </div>
            
            ${process.env.DEMO_MODE === 'true' ? `
            <div class="demo-credentials">
              <strong>Demo Mode:</strong><br>
              Email: test@example.com<br>
              Password: password123
            </div>
            ` : ''}
            
            <form method="POST" action="/login">
              <input type="hidden" name="response_type" value="${response_type}">
              <input type="hidden" name="client_id" value="${client_id}">
              <input type="hidden" name="redirect_uri" value="${redirect_uri}">
              <input type="hidden" name="scope" value="${scope || ''}">
              <input type="hidden" name="code_challenge" value="${code_challenge || ''}">
              <input type="hidden" name="code_challenge_method" value="${code_challenge_method || ''}">
              <input type="hidden" name="state" value="${state || ''}">
              
              <div class="form-group">
                <label for="email">Email</label>
                <input type="email" id="email" name="email" required ${process.env.DEMO_MODE === 'true' ? 'value="test@example.com"' : ''}>
              </div>
              
              <div class="form-group">
                <label for="password">Password</label>
                <input type="password" id="password" name="password" required ${process.env.DEMO_MODE === 'true' ? 'value="password123"' : ''}>
              </div>
              
              <button type="submit" class="btn">Sign In & Authorize</button>
            </form>
            
            <p style="text-align: center; margin-top: 20px; font-size: 12px; color: #6c757d;">
              By signing in, you authorize access to the requested MCP tools and resources.
            </p>
          </div>
        </body>
        </html>
      `);
    });

    // Login form submission handler
    this.app.post('/login', (req, res) => {
      const { email, password, response_type, client_id, redirect_uri, scope, code_challenge, code_challenge_method, state } = req.body;
      
      console.log(`🔐 [${new Date().toISOString()}] Login attempt for email: ${email}`);
      
      // Simple authentication (in demo mode or with configured credentials)
      const validEmail = process.env.DEMO_USER_EMAIL || 'test@example.com';
      const validPassword = process.env.DEMO_USER_PASSWORD || 'password123';
      
      if (email !== validEmail || password !== validPassword) {
        console.log(`❌ Invalid credentials for ${email}`);
        return res.send(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>MCP OAuth - Sign In</title>
            <style>
              body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                max-width: 400px;
                margin: 50px auto;
                padding: 20px;
                background-color: #f5f5f5;
              }
              .login-container {
                background: white;
                padding: 30px;
                border-radius: 8px;
                box-shadow: 0 2px 10px rgba(0,0,0,0.1);
              }
              .error {
                background: #f8d7da;
                color: #721c24;
                padding: 10px;
                border-radius: 4px;
                margin-bottom: 15px;
                font-size: 14px;
              }
            </style>
          </head>
          <body>
            <div class="login-container">
              <h1 style="text-align: center; margin-bottom: 30px; color: #333;">🔐 MCP OAuth</h1>
              <div class="error">
                ❌ Invalid email or password. Please try again.
              </div>
              <a href="/authorize?response_type=${response_type}&client_id=${client_id}&redirect_uri=${encodeURIComponent(redirect_uri)}&scope=${scope || ''}&code_challenge=${code_challenge || ''}&code_challenge_method=${code_challenge_method || ''}&state=${state || ''}">← Back to Login</a>
            </div>
          </body>
          </html>
        `);
      }
      
      console.log(`✅ Successful login for ${email}`);
      
      // Generate authorization code (simple implementation)
      const authCode = 'auth_' + Date.now() + '_' + Math.random().toString(36).substring(2);
      
      // Store authorization code temporarily (in production, use proper storage)
      if (!this.authCodes) {
        this.authCodes = new Map();
      }
      
      const codeData = {
        code: authCode,
        client_id,
        redirect_uri,
        scope: scope || 'mcp:tools',
        code_challenge,
        code_challenge_method,
        user_email: email,
        user_id: 'user_' + Date.now(),
        expires_at: Date.now() + (parseInt(process.env.AUTHORIZATION_CODE_EXPIRY) || 600) * 1000,
        created_at: Date.now()
      };
      
      this.authCodes.set(authCode, codeData);
      
      console.log(`🔑 Generated authorization code: ${authCode}`);
      console.log(`🔀 Redirecting to: ${redirect_uri}`);
      
      // Redirect back to client with authorization code
      const redirectUrl = new URL(redirect_uri);
      redirectUrl.searchParams.set('code', authCode);
      if (state) {
        redirectUrl.searchParams.set('state', state);
      }
      
      res.redirect(redirectUrl.toString());
    });

    // Token endpoint - Handle authorization code exchange
    this.app.post('/token', async (req, res) => {
      try {
        console.log(`🔗 [${new Date().toISOString()}] OAuth token request - processing locally`);
        console.log('Token request body:', req.body);
        
        const { grant_type, code, redirect_uri, client_id, client_secret, code_verifier } = req.body;
        
        // Validate grant type
        if (grant_type !== 'authorization_code') {
          return res.status(400).json({
            error: 'unsupported_grant_type',
            error_description: 'Only authorization_code grant type is supported'
          });
        }
        
        // Validate client credentials
        const defaultClientId = process.env.DEFAULT_CLIENT_ID || 'mcp-client';
        const defaultClientSecret = process.env.DEFAULT_CLIENT_SECRET || 'mcp-secret-change-in-production';
        
        if (client_id !== defaultClientId || client_secret !== defaultClientSecret) {
          return res.status(401).json({
            error: 'invalid_client',
            error_description: 'Invalid client credentials'
          });
        }
        
        // Validate authorization code
        if (!this.authCodes || !this.authCodes.has(code)) {
          return res.status(400).json({
            error: 'invalid_grant',
            error_description: 'Invalid or expired authorization code'
          });
        }
        
        const codeData = this.authCodes.get(code);
        
        // Check if code is expired
        if (Date.now() > codeData.expires_at) {
          this.authCodes.delete(code);
          return res.status(400).json({
            error: 'invalid_grant',
            error_description: 'Authorization code has expired'
          });
        }
        
        // Validate redirect URI
        if (redirect_uri !== codeData.redirect_uri) {
          return res.status(400).json({
            error: 'invalid_grant',
            error_description: 'Redirect URI does not match'
          });
        }
        
        // Validate PKCE (if code challenge was provided)
        if (codeData.code_challenge && process.env.PKCE_REQUIRED === 'true') {
          if (!code_verifier) {
            return res.status(400).json({
              error: 'invalid_request',
              error_description: 'Code verifier required for PKCE flow'
            });
          }
          
          // In a real implementation, you would verify the code_verifier against code_challenge
          // For now, we'll accept any verifier if DEMO_MODE is true
          if (process.env.DEMO_MODE !== 'true') {
            const crypto = require('crypto');
            const hash = crypto.createHash('sha256').update(code_verifier).digest('base64url');
            if (hash !== codeData.code_challenge) {
              return res.status(400).json({
                error: 'invalid_grant',
                error_description: 'Invalid code verifier'
              });
            }
          }
        }
        
        console.log(`✅ Valid authorization code exchange for user: ${codeData.user_email}`);
        
        // Generate access token
        const accessToken = 'access_' + Date.now() + '_' + Math.random().toString(36).substring(2);
        const refreshToken = 'refresh_' + Date.now() + '_' + Math.random().toString(36).substring(2);
        
        // Store tokens (in production, use proper storage)
        if (!this.accessTokens) {
          this.accessTokens = new Map();
        }
        
        const tokenData = {
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: parseInt(process.env.ACCESS_TOKEN_EXPIRY) || 3600,
          refresh_token: refreshToken,
          scope: codeData.scope,
          client_id: codeData.client_id,
          user_id: codeData.user_id,
          user_email: codeData.user_email,
          created_at: Date.now(),
          expires_at: Date.now() + (parseInt(process.env.ACCESS_TOKEN_EXPIRY) || 3600) * 1000
        };
        
        this.accessTokens.set(accessToken, tokenData);
        
        // Delete used authorization code
        this.authCodes.delete(code);
        
        console.log(`🔑 Generated access token: ${accessToken}`);
        
        // Return token response
        const response = {
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: parseInt(process.env.ACCESS_TOKEN_EXPIRY) || 3600,
          refresh_token: refreshToken,
          scope: codeData.scope
        };
        
        console.log('Token response:', response);
        res.json(response);
        
      } catch (error) {
        console.error('❌ Token endpoint error:', error);
        res.status(500).json({
          error: 'server_error',
          error_description: 'Token endpoint processing failed'
        });
      }
    });

    // Introspection endpoint - Handle token validation locally
    this.app.post('/introspect', async (req, res) => {
      try {
        console.log(`🔗 [${new Date().toISOString()}] OAuth introspection request - processing locally`);
        
        const { token } = req.body;
        
        if (!token) {
          return res.json({
            active: false
          });
        }
        
        // Check if token exists in our storage
        if (!this.accessTokens || !this.accessTokens.has(token)) {
          console.log(`❌ Token not found: ${token}`);
          return res.json({
            active: false
          });
        }
        
        const tokenData = this.accessTokens.get(token);
        
        // Check if token is expired
        if (Date.now() > tokenData.expires_at) {
          console.log(`❌ Token expired: ${token}`);
          this.accessTokens.delete(token);
          return res.json({
            active: false
          });
        }
        
        console.log(`✅ Valid token introspection for user: ${tokenData.user_email}`);
        
        // Return token introspection response
        res.json({
          active: true,
          client_id: tokenData.client_id,
          username: tokenData.user_email,
          scope: tokenData.scope,
          token_type: 'Bearer',
          exp: Math.floor(tokenData.expires_at / 1000),
          iat: Math.floor(tokenData.created_at / 1000),
          sub: tokenData.user_id,
          aud: tokenData.client_id
        });
        
      } catch (error) {
        console.error('❌ Introspection endpoint error:', error);
        res.status(500).json({
          error: 'server_error',
          error_description: 'Introspection endpoint processing failed'
        });
      }
    });

    // OAuth server metadata endpoint
    this.app.get('/.well-known/oauth-authorization-server', async (req, res) => {
      try {
        console.log(`🔗 [${new Date().toISOString()}] OAuth metadata request - serving local metadata`);
        
        const baseUrl = `https://${req.get('host')}`;
        
        const metadata = {
          issuer: baseUrl,
          authorization_endpoint: `${baseUrl}/authorize`,
          token_endpoint: `${baseUrl}/token`,
          registration_endpoint: `${baseUrl}/register`,
          introspection_endpoint: `${baseUrl}/introspect`,
          scopes_supported: [
            'openid',
            'email', 
            'profile',
            'mcp:tools',
            'mcp:admin'
          ],
          response_types_supported: [
            'code'
          ],
          grant_types_supported: [
            'authorization_code',
            'refresh_token'
          ],
          token_endpoint_auth_methods_supported: [
            'client_secret_post'
          ],
          code_challenge_methods_supported: [
            'S256'
          ],
          pkce_required: process.env.PKCE_REQUIRED === 'true',
          authorization_code_expiry: parseInt(process.env.AUTHORIZATION_CODE_EXPIRY) || 600,
          access_token_expiry: parseInt(process.env.ACCESS_TOKEN_EXPIRY) || 3600,
          refresh_token_expiry: parseInt(process.env.REFRESH_TOKEN_EXPIRY) || 86400
        };
        
        console.log('OAuth metadata served');
        res.json(metadata);
        
      } catch (error) {
        console.error('❌ OAuth metadata endpoint error:', error);
        res.status(500).json({
          error: 'server_error',
          error_description: 'OAuth metadata endpoint failed'
        });
      }
    });

    // Authorization flow starter endpoint
    this.app.get('/authorization', (req, res) => {
      // Check if it's a proper OAuth request with parameters
      if (req.query.response_type && req.query.client_id) {
        // Forward to OAuth server with all parameters
        const oauthUrl = new URL(`${this.oauthServerUrl}/authorize`);
        Object.entries(req.query).forEach(([key, value]) => {
          oauthUrl.searchParams.set(key, value);
        });
        return res.redirect(oauthUrl.toString());
      }
      
      // If no OAuth parameters, show authorization flow starter page
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>MCP OAuth Authorization</title>
          <style>
            body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
            .section { margin: 20px 0; padding: 15px; border: 1px solid #ddd; border-radius: 5px; }
            .oauth-url { background: #f5f5f5; padding: 10px; border-radius: 5px; overflow-x: auto; word-break: break-all; }
            .button { display: inline-block; padding: 10px 20px; background: #007cba; color: white; text-decoration: none; border-radius: 5px; margin: 10px 5px; }
            .error { color: #dc3545; font-weight: bold; }
            .success { color: #28a745; font-weight: bold; }
          </style>
        </head>
        <body>
          <h1>🔐 MCP OAuth Authorization</h1>
          
          <div class="section">
            <h2>📋 OAuth Flow Information</h2>
            <p>This MCP server requires OAuth 2.1 authentication with PKCE.</p>
            <p><strong>OAuth Server:</strong> ${this.oauthServerUrl}</p>
          </div>

          ${process.env.DEMO_MODE === 'true' ? `
          <div class="section">
            <h2>🧪 Demo Mode - Quick Start</h2>
            <p class="success">Demo mode is enabled! Use these demo credentials:</p>
            <ul>
              <li><strong>Email:</strong> test@example.com</li>
              <li><strong>Password:</strong> password123</li>
            </ul>
            
            <h3>🚀 Start OAuth Flow</h3>
            <p>Click to start the OAuth authorization flow with a demo client:</p>
            <a href="${this.oauthServerUrl}/authorize?response_type=code&client_id=mcp-demo-client&redirect_uri=http://localhost:${this.port}/oauth/callback&scope=mcp:tools&code_challenge=demo-challenge&code_challenge_method=S256&state=demo-state" class="button">
              Start Demo OAuth Flow
            </a>
          </div>
          ` : ''}

          <div class="section">
            <h2>🔗 OAuth Endpoints</h2>
            <ul>
              <li><strong>Authorization:</strong> <code>${this.oauthServerUrl}/authorize</code></li>
              <li><strong>Token:</strong> <code>${this.oauthServerUrl}/token</code></li>
              <li><strong>Registration:</strong> <code>${this.oauthServerUrl}/register</code></li>
              <li><strong>Introspection:</strong> <code>${this.oauthServerUrl}/introspect</code></li>
              <li><strong>Metadata:</strong> <code>${this.oauthServerUrl}/.well-known/oauth-authorization-server</code></li>
            </ul>
          </div>

          <div class="section">
            <h2>📖 Required Parameters</h2>
            <p>To manually start an OAuth flow, you need these parameters:</p>
            <ul>
              <li><code>response_type=code</code></li>
              <li><code>client_id=[your_client_id]</code></li>
              <li><code>redirect_uri=[your_callback_url]</code></li>
              <li><code>scope=mcp:tools</code></li>
              <li><code>code_challenge=[pkce_challenge]</code></li>
              <li><code>code_challenge_method=S256</code></li>
              <li><code>state=[random_state]</code> (optional)</li>
            </ul>
          </div>

          <div class="section">
            <h2>🛠️ Next Steps</h2>
            <ol>
              <li><strong>Register a client</strong> at <code>${this.oauthServerUrl}/register</code></li>
              <li><strong>Generate PKCE challenge/verifier</strong></li>
              <li><strong>Start authorization flow</strong> at <code>${this.oauthServerUrl}/authorize</code></li>
              <li><strong>Exchange code for token</strong> at <code>${this.oauthServerUrl}/token</code></li>
              <li><strong>Use Bearer token</strong> with MCP endpoints</li>
            </ol>
          </div>
        </body>
        </html>
      `);
    });

    // OAuth callback handler for demo flow
    this.app.get('/oauth/callback', (req, res) => {
      const { code, state, error, error_description } = req.query;
      
      if (error) {
        return res.send(`
          <!DOCTYPE html>
          <html>
          <head><title>OAuth Error</title></head>
          <body>
            <h1>❌ OAuth Authorization Failed</h1>
            <p><strong>Error:</strong> ${error}</p>
            <p><strong>Description:</strong> ${error_description || 'Unknown error'}</p>
            <a href="/authorization">← Back to Authorization</a>
          </body>
          </html>
        `);
      }
      
      if (code) {
        return res.send(`
          <!DOCTYPE html>
          <html>
          <head><title>OAuth Success</title></head>
          <body>
            <h1>✅ OAuth Authorization Successful</h1>
            <p><strong>Authorization Code:</strong> <code>${code}</code></p>
            <p><strong>State:</strong> <code>${state || 'none'}</code></p>
            <p>You can now exchange this code for an access token at <code>${this.oauthServerUrl}/token</code></p>
            <a href="/authorization">← Back to Authorization</a>
          </body>
          </html>
        `);
      }
      
      res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>OAuth Callback</title></head>
        <body>
          <h1>🔐 OAuth Callback</h1>
          <p>No authorization code received.</p>
          <a href="/authorization">← Back to Authorization</a>
        </body>
        </html>
      `);
    });

    // Demo endpoint for testing (only in demo mode)
    if (process.env.DEMO_MODE === 'true') {
      this.app.get('/demo', (req, res) => {
        res.send(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>MCP OAuth Server - Demo</title>
            <style>
              body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
              .endpoint { margin: 15px 0; padding: 10px; border: 1px solid #ddd; border-radius: 5px; }
              code { background: #f5f5f5; padding: 2px 4px; border-radius: 3px; }
              pre { background: #f5f5f5; padding: 10px; border-radius: 5px; overflow-x: auto; }
            </style>
          </head>
          <body>
            <h1>🔐 MCP OAuth Server - Demo</h1>
            <p>This server provides OAuth-protected MCP endpoints.</p>

            <h2>📋 Available Endpoints</h2>
            
            <div class="endpoint">
              <strong>GET /health</strong> - Health check (no auth required)
            </div>
            
            <div class="endpoint">
              <strong>GET /sse</strong> - Server-Sent Events endpoint (requires Bearer token)
            </div>
            
            <div class="endpoint">
              <strong>POST /message</strong> - MCP message handling (requires Bearer token)
            </div>
            
            <div class="endpoint">
              <strong>GET /tools</strong> - Available tools list (requires Bearer token)
            </div>

            <h2>🔧 Getting Started</h2>
            <ol>
              <li>Register OAuth client: <code>POST ${this.oauthServerUrl}/register</code></li>
              <li>Get authorization code: <code>GET ${this.oauthServerUrl}/authorize</code></li>
              <li>Exchange for access token: <code>POST ${this.oauthServerUrl}/token</code></li>
              <li>Use token with MCP endpoints: <code>Authorization: Bearer &lt;token&gt;</code></li>
            </ol>

            <h2>🧪 Test Commands</h2>
            <pre>
# Health check
curl ${req.protocol}://${req.get('host')}/health

# OAuth metadata
curl ${this.oauthServerUrl}/.well-known/oauth-authorization-server

# Register client
curl -X POST ${this.oauthServerUrl}/register \\
  -H "Content-Type: application/json" \\
  -d '{"client_name":"Test Client","redirect_uris":["http://localhost:8847/callback"]}'
            </pre>
          </body>
          </html>
        `);
      });
    }
  }

  setupErrorHandling() {
    // 404 handler
    this.app.use((req, res) => {
      res.status(404).json({
        error: 'not_found',
        message: `Endpoint ${req.method} ${req.path} not found`,
        available_endpoints: [
          'GET /',
          'GET /health',
          'GET /sse',
          'POST /message',
          'GET /tools',
          'POST /execute'
        ]
      });
    });

    // Enhanced Error handler
    this.app.use((err, req, res, next) => {
      const requestId = req.requestId || 'unknown';
      const timestamp = new Date().toISOString();
      
      // Detailed error logging
      console.log(`\n🔴 [${timestamp}] SERVER ERROR [${requestId}]`);
      console.log(`❌ Error Name: ${err.name || 'Unknown'}`);
      console.log(`💬 Error Message: ${err.message || 'No message'}`);
      console.log(`🔢 Error Status: ${err.status || 500}`);
      console.log(`📍 Request: ${req.method} ${req.url}`);
      console.log(`🌐 Client: ${req.ip}`);
      
      // Log error stack (in development)
      if (process.env.NODE_ENV === 'development' || process.env.DEMO_MODE === 'true') {
        console.log(`📚 Stack Trace:`);
        console.log(err.stack);
      }
      
      // Log additional error properties
      if (Object.keys(err).length > 0) {
        console.log(`🔍 Error Properties:`, JSON.stringify(err, Object.getOwnPropertyNames(err), 2));
      }
      
      let errorResponse;
      
      // Handle CORS errors
      if (err.message && err.message.includes('CORS')) {
        errorResponse = {
          error: 'cors_error',
          message: 'CORS policy violation',
          request_id: requestId,
          timestamp
        };
        console.log(`📤 Sending CORS error response`);
        return res.status(403).json(errorResponse);
      }
      
      // Handle OAuth errors
      if (err.name === 'UnauthorizedError' || err.message.includes('token')) {
        errorResponse = {
          error: 'authentication_error',
          message: err.message || 'Authentication failed',
          request_id: requestId,
          timestamp
        };
        console.log(`📤 Sending auth error response`);
        return res.status(401).json(errorResponse);
      }
      
      // Generic error response
      errorResponse = {
        error: err.name || 'server_error',
        message: err.message || 'Internal server error',
        request_id: requestId,
        timestamp,
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
      };
      
      console.log(`📤 Sending error response:`, JSON.stringify(errorResponse, null, 2));
      console.log(`─────────────────────────────────────────────────────────────`);
      
      res.status(err.status || 500).json(errorResponse);
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', (err) => {
      console.error('[MCP OAuth] Uncaught exception:', err);
      process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
      console.error('[MCP OAuth] Unhandled rejection at:', promise, 'reason:', reason);
      process.exit(1);
    });
  }

  /**
   * Handle MCP request locally (fallback)
   */
  async handleMCPRequestLocally(request, oauthData) {
    const { method, params, id } = request;
    
    try {
      switch (method) {
        case 'initialize':
          // Support multiple protocol versions based on client request
          const clientVersion = request.params?.protocolVersion || '2024-11-05';
          const supportedVersions = ['2024-11-05', '2025-06-18', '2025-11-25'];
          const protocolVersion = supportedVersions.includes(clientVersion) ? clientVersion : '2024-11-05';
          
          return {
            jsonrpc: '2.0',
            id: id,
            result: {
              protocolVersion: protocolVersion,
              capabilities: {
                tools: {},
                logging: {}
              },
              serverInfo: {
                name: 'mcp-oauth-server',
                version: '1.0.0'
              }
            }
          };
          
        case 'tools/list':
          return {
            jsonrpc: '2.0',
            id: id,
            result: {
              tools: [
                {
                  name: 'echo',
                  description: 'Echo back the input text',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      text: { type: 'string', description: 'Text to echo' }
                    },
                    required: ['text']
                  }
                },
                {
                  name: 'oauth_info',
                  description: 'Get current OAuth token information',
                  inputSchema: {
                    type: 'object',
                    properties: {},
                    required: []
                  }
                }
              ]
            }
          };
          
        case 'tools/call':
          const { name, arguments: args } = params;
          
          switch (name) {
            case 'echo':
              return {
                jsonrpc: '2.0',
                id: id,
                result: {
                  content: [
                    {
                      type: 'text',
                      text: `Echo: ${args.text || 'No text provided'}`
                    }
                  ]
                }
              };
              
            case 'oauth_info':
              return {
                jsonrpc: '2.0',
                id: id,
                result: {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({
                        client_id: oauthData.client_id,
                        user_id: oauthData.user_id,
                        scope: oauthData.scope,
                        token_active: true,
                        cached: oauthData.cached || false
                      }, null, 2)
                    }
                  ]
                }
              };
              
            default:
              throw new Error(`Unknown tool: ${name}`);
          }
          
        default:
          throw new Error(`Unknown method: ${method}`);
      }
      
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id: id,
        error: {
          code: -32601,
          message: 'Method not found',
          data: error.message
        }
      };
    }
  }

  start() {
    const server = this.app.listen(this.port, this.host, () => {
      console.log(`🚀 MCP OAuth Server started`);
      console.log(`📡 Server: http://${this.host}:${this.port}`);
      console.log(`🔐 OAuth Server: ${this.oauthServerUrl}`);
      console.log(`📋 Health: http://${this.host}:${this.port}/health`);
      console.log(`🌊 SSE: http://${this.host}:${this.port}/sse`);
      console.log(`💬 Messages: http://${this.host}:${this.port}/message`);
      console.log(`🔧 Tools: http://${this.host}:${this.port}/tools`);
      
      if (process.env.DEMO_MODE === 'true') {
        console.log(`🧪 Demo: http://${this.host}:${this.port}/demo`);
      }
      
      console.log(`📊 Active SSE Connections: ${this.connectionManager.getStats().total_connections}`);
      console.log(`✅ MCP OAuth Server ready!`);
    });

    // Graceful shutdown
    const gracefulShutdown = () => {
      console.log('\n🛑 Shutting down MCP OAuth Server...');
      
      // Close all SSE connections
      this.connectionManager.broadcast('shutdown', {
        message: 'Server shutting down',
        timestamp: new Date().toISOString()
      });
      
      server.close(() => {
        console.log('✅ MCP OAuth Server closed');
        process.exit(0);
      });
    };

    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGINT', gracefulShutdown);

    return server;
  }
}

// Start server if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new MCPOAuthServer();
  server.start();
}

export default MCPOAuthServer;