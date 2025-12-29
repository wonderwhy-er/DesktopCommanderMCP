#!/usr/bin/env node

/**
 * OAuth 2.1 Authorization Server
 * Implementation using Express.js and Passport.js
 */

// Load environment variables
import 'dotenv/config';

import express from 'express';
import session from 'express-session';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

// Import local modules
const { passport } = require('./config/passport.cjs');
const { applyCors } = require('./middleware/cors.cjs');

// Import routes
const authRoutes = require('./routes/auth.cjs');
const registerRoutes = require('./routes/register.cjs');
const introspectRoutes = require('./routes/introspect.cjs');

// Import models to initialize stores
const clientStore = require('./models/oauth-server/models/client.cjs');
const tokenStore = require('./models/oauth-server/models/token.cjs');
const userStore = require('./models/oauth-server/models/user.cjs');

class OAuthServer {
  constructor() {
    this.app = express();
    this.port = parseInt(process.env.OAUTH_PORT) || 4449;
    this.httpsPort = parseInt(process.env.OAUTH_HTTPS_PORT) || 4450;
    this.host = process.env.OAUTH_HOST || 'localhost';
    this.enableHttps = process.env.ENABLE_HTTPS === 'true';
    
    this.setupMiddleware();
    this.setupRoutes();
    this.setupErrorHandling();
  }

  setupMiddleware() {
    // Apply CORS
    applyCors(this.app);

    // Parse JSON and URL-encoded bodies
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Session configuration
    this.app.use(session({
      secret: process.env.SESSION_SECRET || 'oauth-session-secret',
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: false, // Set to true in production with HTTPS
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
      }
    }));

    // Initialize Passport
    this.app.use(passport.initialize());
    this.app.use(passport.session());

    // Request logging
    this.app.use((req, res, next) => {
      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] ${req.method} ${req.url} - ${req.ip}`);
      next();
    });

    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        server: 'oauth-authorization-server',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        env: {
          demo_mode: process.env.DEMO_MODE === 'true',
          pkce_required: process.env.PKCE_REQUIRED !== 'false'
        },
        stats: {
          clients: clientStore.getAllClients().length,
          tokens: tokenStore.getStats(),
          users: userStore.getStats()
        }
      });
    });
  }

  setupRoutes() {
    // OAuth routes
    this.app.use('/', authRoutes);
    this.app.use('/', registerRoutes);
    this.app.use('/', introspectRoutes);

    // Simple login endpoint for demo
    if (process.env.DEMO_MODE === 'true') {
      this.app.post('/login', passport.authenticate('local'), (req, res) => {
        res.json({
          success: true,
          user: req.user,
          message: 'Login successful'
        });
      });

      this.app.post('/logout', (req, res) => {
        req.logout((err) => {
          if (err) {
            return res.status(500).json({ error: 'Logout failed' });
          }
          res.json({ success: true, message: 'Logout successful' });
        });
      });

      // Simple status endpoint
      this.app.get('/status', (req, res) => {
        res.json({
          authenticated: req.isAuthenticated(),
          user: req.user || null,
          session: req.sessionID
        });
      });
    }

    // Root endpoint
    this.app.get('/', (req, res) => {
      res.json({
        server: 'OAuth 2.1 Authorization Server',
        version: '1.0.0',
        specification: 'RFC 6749, RFC 7636, RFC 7662',
        mcp_support: true,
        endpoints: {
          authorization: '/authorize',
          token: '/token', 
          registration: '/register',
          introspection: '/introspect',
          revocation: '/revoke',
          metadata: '/.well-known/oauth-authorization-server'
        },
        demo_mode: process.env.DEMO_MODE === 'true',
        documentation: process.env.OAUTH_BASE_URL + '/docs'
      });
    });

    // Documentation endpoint
    this.app.get('/docs', (req, res) => {
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>OAuth 2.1 Authorization Server - Documentation</title>
          <style>
            body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
            code { background: #f5f5f5; padding: 2px 4px; border-radius: 3px; }
            pre { background: #f5f5f5; padding: 10px; border-radius: 5px; overflow-x: auto; }
            .endpoint { margin: 20px 0; padding: 15px; border: 1px solid #ddd; border-radius: 5px; }
            .method { display: inline-block; padding: 2px 8px; border-radius: 3px; color: white; font-weight: bold; margin-right: 10px; }
            .get { background: #007cba; }
            .post { background: #28a745; }
            h1, h2 { color: #333; }
          </style>
        </head>
        <body>
          <h1>🔐 OAuth 2.1 Authorization Server</h1>
          <p>MCP-compliant OAuth authorization server with PKCE support</p>

          <h2>📚 Endpoints</h2>

          <div class="endpoint">
            <span class="method get">GET</span>
            <strong>/.well-known/oauth-authorization-server</strong>
            <p>OAuth authorization server metadata (RFC 8414)</p>
          </div>

          <div class="endpoint">
            <span class="method get">GET</span>
            <strong>/authorize</strong>
            <p>OAuth authorization endpoint - initiate authorization flow</p>
            <p>Parameters: <code>response_type</code>, <code>client_id</code>, <code>redirect_uri</code>, <code>scope</code>, <code>state</code>, <code>code_challenge</code>, <code>code_challenge_method</code></p>
          </div>

          <div class="endpoint">
            <span class="method post">POST</span>
            <strong>/token</strong>
            <p>OAuth token endpoint - exchange authorization code for tokens</p>
            <p>Supports: authorization_code and refresh_token grant types</p>
          </div>

          <div class="endpoint">
            <span class="method post">POST</span>
            <strong>/register</strong>
            <p>Dynamic client registration (RFC 7591)</p>
          </div>

          <div class="endpoint">
            <span class="method post">POST</span>
            <strong>/introspect</strong>
            <p>Token introspection (RFC 7662)</p>
          </div>

          <div class="endpoint">
            <span class="method post">POST</span>
            <strong>/revoke</strong>
            <p>Token revocation (RFC 7009)</p>
          </div>

          <h2>🔧 Configuration</h2>
          <pre>
Demo Mode: ${process.env.DEMO_MODE === 'true' ? 'Enabled' : 'Disabled'}
PKCE Required: ${process.env.PKCE_REQUIRED !== 'false' ? 'Yes' : 'No'}
Supported Scopes: openid, email, profile, mcp:tools, mcp:admin
          </pre>

          <h2>🚀 MCP Integration</h2>
          <p>This server provides OAuth 2.1 authentication for MCP (Model Context Protocol) clients with:</p>
          <ul>
            <li>PKCE (Proof Key for Code Exchange) security</li>
            <li>Bearer token authentication</li>
            <li>Server-Sent Events (SSE) transport</li>
            <li>MCP Authorization Specification compliance</li>
          </ul>

          ${process.env.DEMO_MODE === 'true' ? `
          <h2>🧪 Demo Mode</h2>
          <p>Demo credentials:</p>
          <ul>
            <li>Email: <code>${process.env.DEMO_USER_EMAIL || 'test@example.com'}</code></li>
            <li>Password: <code>${process.env.DEMO_USER_PASSWORD || 'password123'}</code></li>
          </ul>
          ` : ''}
        </body>
        </html>
      `);
    });
  }

  setupErrorHandling() {
    // 404 handler
    this.app.use((req, res) => {
      res.status(404).json({
        error: 'not_found',
        error_description: `Endpoint ${req.method} ${req.path} not found`,
        available_endpoints: [
          '/.well-known/oauth-authorization-server',
          '/authorize',
          '/token',
          '/register',
          '/introspect',
          '/revoke',
          '/health'
        ]
      });
    });

    // Error handler
    this.app.use((err, req, res, next) => {
      console.error('[OAuth] Server error:', err);
      
      res.status(err.status || 500).json({
        error: err.name || 'server_error',
        error_description: err.message || 'Internal server error'
      });
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', (err) => {
      console.error('[OAuth] Uncaught exception:', err);
      process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
      console.error('[OAuth] Unhandled rejection at:', promise, 'reason:', reason);
      process.exit(1);
    });
  }

  start() {
    const servers = [];

    // Start HTTP server
    const httpServer = this.app.listen(this.port, this.host, () => {
      console.log(`🔐 OAuth 2.1 Authorization Server started`);
      console.log(`📡 HTTP Server: http://${this.host}:${this.port}`);
      console.log(`📋 Health: http://${this.host}:${this.port}/health`);
      console.log(`📚 Docs: http://${this.host}:${this.port}/docs`);
      console.log(`🔍 Metadata: http://${this.host}:${this.port}/.well-known/oauth-authorization-server`);
      
      if (this.enableHttps) {
        console.log(`🔒 HTTPS Server: https://${this.host}:${this.httpsPort}`);
        console.log(`🔒 HTTPS Health: https://${this.host}:${this.httpsPort}/health`);
      }
      
      console.log(`🧪 Demo Mode: ${process.env.DEMO_MODE === 'true' ? 'Enabled' : 'Disabled'}`);
      console.log(`🔒 PKCE Required: ${process.env.PKCE_REQUIRED !== 'false' ? 'Yes' : 'No'}`);
      
      if (process.env.DEMO_MODE === 'true') {
        console.log(`👤 Demo User: ${process.env.DEMO_USER_EMAIL || 'test@example.com'}`);
        console.log(`🔑 Demo Password: ${process.env.DEMO_USER_PASSWORD || 'password123'}`);
      }
      
      console.log(`✅ OAuth server ready for MCP clients!`);
    });

    servers.push(httpServer);

    // Start HTTPS server if enabled
    if (this.enableHttps) {
      try {
        const certPath = path.join(__dirname, '../../certs/server.crt');
        const keyPath = path.join(__dirname, '../../certs/server.key');
        
        if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
          const httpsOptions = {
            key: fs.readFileSync(keyPath),
            cert: fs.readFileSync(certPath)
          };

          const httpsServer = https.createServer(httpsOptions, this.app);
          httpsServer.listen(this.httpsPort, this.host, () => {
            console.log(`🔒 HTTPS OAuth Server started on port ${this.httpsPort}`);
          });
          
          servers.push(httpsServer);
        } else {
          console.warn(`⚠️  HTTPS enabled but certificates not found at ${certPath} or ${keyPath}`);
          console.warn(`⚠️  Continuing with HTTP only`);
        }
      } catch (error) {
        console.error(`❌ Failed to start HTTPS server: ${error.message}`);
        console.warn(`⚠️  Continuing with HTTP only`);
      }
    }

    // Graceful shutdown
    const gracefulShutdown = () => {
      console.log('\n🛑 Shutting down OAuth server...');
      let closed = 0;
      
      servers.forEach(server => {
        server.close(() => {
          closed++;
          if (closed === servers.length) {
            console.log('✅ OAuth server closed');
            process.exit(0);
          }
        });
      });
      
      // Force exit after 5 seconds
      setTimeout(() => {
        console.log('⚠️  Force exit after timeout');
        process.exit(1);
      }, 5000);
    };

    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGINT', gracefulShutdown);

    return httpServer;
  }
}

// Start server if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new OAuthServer();
  server.start();
}

export default OAuthServer;