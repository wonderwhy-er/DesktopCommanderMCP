#!/usr/bin/env node

/**
 * Remote MCP Server OAuth Connector
 * 
 * This connector automatically handles OAuth authentication and provides remote MCP tools.
 * It's designed to work as a Claude Desktop custom connector, not an MCP server.
 * 
 * Usage:
 * 1. Add to Claude Desktop as a custom connector
 * 2. It will automatically open OAuth login in browser
 * 3. After authentication, provides remote MCP capabilities
 */

// Load environment variables
require('dotenv').config();

const { exec } = require('child_process');
const http = require('http');
const https = require('https');
const url = require('url');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class RemoteMCPOAuthConnector {
  constructor() {
    // Load configuration from environment variables
    this.mcpServerUrl = process.env.MCP_SERVER_URL || 'http://localhost:3006';
    this.oauthServerUrl = process.env.OAUTH_AUTH_SERVER_URL || 'http://localhost:4449';
    this.remoteServerUrl = process.env.REMOTE_DC_SERVER_URL || 'http://localhost:3002';
    this.clientId = process.env.OAUTH_CLIENT_ID || 'remote-mcp-client';
    this.clientSecret = process.env.OAUTH_CLIENT_SECRET || 'remote-mcp-secret-change-in-production';
    this.redirectUri = process.env.OAUTH_REDIRECT_URI || 'http://localhost:3003/auth/callback';
    this.scopes = process.env.OAUTH_SCOPES || 'openid email profile mcp:tools';
    
    this.sessions = new Map(); // Store multiple user sessions
    this.authStates = new Map(); // Store OAuth states for multiple users
    this.authCallbackPort = 8847; // Port for OAuth callback
    this.mcpPort = 8848; // Port for MCP interface
    this.useHttps = process.env.USE_HTTPS === 'true' || process.argv.includes('--https');
    this.certPath = './certs';
    
    this.log('🔐 Remote MCP OAuth Connector starting...');
    this.log('🚀 Multi-user OAuth connector initialized');
    this.log('💡 OAuth authentication will start when users access the connector');
    
    if (this.useHttps) {
      this.log('🔒 HTTPS mode enabled - checking certificates...');
      this.ensureSSLCertificates().then(() => {
        this.startCallbackServer();
        this.startMCPInterface();
      }).catch(error => {
        this.log(`❌ SSL setup failed: ${error.message}`);
        this.log('🔄 Falling back to HTTP mode...');
        this.useHttps = false;
        this.startCallbackServer();
        this.startMCPInterface();
      });
    } else {
      this.log('📡 HTTP mode (use --https flag or USE_HTTPS=true for HTTPS)');
      this.startCallbackServer();
      this.startMCPInterface();
    }
  }

  log(message) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] ${message}`);
  }

  generateSessionId() {
    return crypto.randomBytes(16).toString('hex');
  }

  isSessionAuthenticated(sessionId) {
    return this.sessions.has(sessionId) && this.sessions.get(sessionId).accessToken;
  }

  async ensureSSLCertificates() {
    const keyPath = path.join(this.certPath, 'server.key');
    const certPath = path.join(this.certPath, 'server.crt');

    // Check if certificates exist
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
      this.log('✅ SSL certificates found');
      return { keyPath, certPath };
    }

    this.log('📝 Generating self-signed SSL certificates...');
    
    // Create certs directory
    if (!fs.existsSync(this.certPath)) {
      fs.mkdirSync(this.certPath, { recursive: true });
    }

    return new Promise((resolve, reject) => {
      const opensslCommand = `openssl req -x509 -newkey rsa:4096 -keyout "${keyPath}" -out "${certPath}" -sha256 -days 365 -nodes -subj "/C=US/ST=Dev/L=Local/O=RemoteMCP/CN=localhost"`;
      
      exec(opensslCommand, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Failed to generate SSL certificates: ${error.message}`));
          return;
        }
        
        this.log('✅ SSL certificates generated successfully');
        this.log(`📄 Certificate: ${certPath}`);
        this.log(`🔑 Private Key: ${keyPath}`);
        resolve({ keyPath, certPath });
      });
    });
  }

  getSSLOptions() {
    const keyPath = path.join(this.certPath, 'server.key');
    const certPath = path.join(this.certPath, 'server.crt');
    
    return {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath)
    };
  }

  async checkServerHealth() {
    this.log('🔍 Checking server health...');
    
    return new Promise((resolve, reject) => {
      const req = http.get(`${this.serverUrl}/health`, (res) => {
        if (res.statusCode === 200) {
          this.log('✅ Server is healthy');
          resolve();
        } else {
          reject(new Error(`Server returned ${res.statusCode}`));
        }
      });
      
      req.on('error', (error) => {
        reject(new Error(`Server not reachable: ${error.message}`));
      });
      
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error('Server health check timeout'));
      });
    });
  }

  async startCallbackServer() {
    return new Promise((resolve, reject) => {
      const requestHandler = (req, res) => {
        const parsedUrl = url.parse(req.url, true);
        
        if (parsedUrl.pathname === '/oauth/callback') {
          this.handleOAuthCallback(parsedUrl.query, res);
        } else {
          res.writeHead(404);
          res.end('Not Found');
        }
      };

      if (this.useHttps) {
        try {
          const sslOptions = this.getSSLOptions();
          this.callbackServer = https.createServer(sslOptions, requestHandler);
        } catch (error) {
          reject(new Error(`Failed to create HTTPS callback server: ${error.message}`));
          return;
        }
      } else {
        this.callbackServer = http.createServer(requestHandler);
      }

      this.callbackServer.listen(this.authCallbackPort, () => {
        const protocol = this.useHttps ? 'https' : 'http';
        this.log(`🔗 OAuth callback server listening on ${protocol}://localhost:${this.authCallbackPort}`);
        resolve();
      });

      this.callbackServer.on('error', (error) => {
        reject(new Error(`Failed to start callback server: ${error.message}`));
      });
    });
  }

  async initiateOAuth(sessionId) {
    // Generate a secure state parameter for this session
    const authState = crypto.randomBytes(16).toString('hex');
    this.authStates.set(sessionId, authState);
    
    // Build OAuth URL that redirects to our local callback
    const protocol = this.useHttps ? 'https' : 'http';
    const callbackUrl = `${protocol}://localhost:${this.authCallbackPort}/oauth/callback`;
    const oauthParams = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: callbackUrl,
      scope: this.scopes,
      state: authState
    });

    const authEndpoint = process.env.OAUTH_AUTHORIZE_ENDPOINT || '/authorize';
    const oauthUrl = `${this.oauthServerUrl}${authEndpoint}?${oauthParams.toString()}`;
    
    this.log(`🌐 Opening OAuth login for session ${sessionId}...`);
    this.log(`🔗 OAuth URL: ${oauthUrl}`);
    this.log(`🔄 Callback: ${protocol}://localhost:${this.authCallbackPort}/oauth/callback`);
    
    // Open browser automatically
    const openCommand = process.platform === 'darwin' ? 'open' : 
                       process.platform === 'win32' ? 'start' : 'xdg-open';
    
    exec(`${openCommand} "${oauthUrl}"`, (error) => {
      if (error) {
        this.log(`⚠️  Could not open browser automatically: ${error.message}`);
        this.log(`🖱️  Please manually open: ${oauthUrl}`);
      } else {
        this.log('✅ Browser opened for OAuth login');
      }
    });

    this.log(`⏳ Waiting for OAuth callback for session ${sessionId}...`);
    return oauthUrl;
  }

  handleOAuthCallback(query, res) {
    this.log('📨 Received OAuth callback');

    if (query.error) {
      this.log(`❌ OAuth error: ${query.error} - ${query.error_description}`);
      res.writeHead(400, {'Content-Type': 'text/html'});
      res.end(`
        <html>
          <head><title>Remote MCP OAuth - Error</title></head>
          <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
            <h1>❌ Authentication Failed</h1>
            <p>Error: ${query.error}</p>
            <p>${query.error_description || ''}</p>
            <p>Please try again or contact support.</p>
          </body>
        </html>
      `);
      return;
    }

    if (!query.code) {
      this.log('❌ No authorization code received');
      res.writeHead(400, {'Content-Type': 'text/html'});
      res.end(`
        <html>
          <head><title>Remote MCP OAuth - Error</title></head>
          <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
            <h1>❌ Authentication Failed</h1>
            <p>No authorization code received</p>
            <p>Please try again.</p>
          </body>
        </html>
      `);
      return;
    }

    // Find the session ID that matches this state
    let sessionId = null;
    for (const [sid, state] of this.authStates.entries()) {
      if (state === query.state) {
        sessionId = sid;
        break;
      }
    }

    if (!sessionId) {
      this.log('❌ Invalid OAuth state parameter - no matching session found');
      res.writeHead(400, {'Content-Type': 'text/html'});
      res.end(`
        <html>
          <head><title>Remote MCP OAuth - Error</title></head>
          <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
            <h1>❌ Authentication Failed</h1>
            <p>Invalid or expired authentication request</p>
            <p>Please try again.</p>
          </body>
        </html>
      `);
      return;
    }

    // Send success page to browser
    res.writeHead(200, {'Content-Type': 'text/html'});
    res.end(`
      <html>
        <head><title>Remote MCP OAuth</title></head>
        <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
          <h1>🎉 Authentication Successful!</h1>
          <p>You can now close this browser window.</p>
          <p>Remote MCP is ready to use in Claude Desktop.</p>
        </body>
      </html>
    `);

    this.log(`✅ OAuth callback validation successful for session ${sessionId}`);
    this.exchangeCodeForToken(query.code, sessionId);
  }

  async exchangeCodeForToken(authCode, sessionId) {
    this.log(`🔄 Exchanging authorization code for access token (session ${sessionId})...`);
    
    const protocol = this.useHttps ? 'https' : 'http';
    const callbackUrl = `${protocol}://localhost:${this.authCallbackPort}/oauth/callback`;
    const tokenData = new URLSearchParams({
      grant_type: 'authorization_code',
      code: authCode,
      redirect_uri: callbackUrl,
      client_id: this.clientId,
      client_secret: this.clientSecret
    });

    return new Promise((resolve, reject) => {
      const postData = tokenData.toString();
      const oauthUrl = new URL(this.oauthServerUrl);
      const tokenEndpoint = process.env.OAUTH_TOKEN_ENDPOINT || '/token';
      
      const options = {
        hostname: oauthUrl.hostname,
        port: oauthUrl.port,
        path: tokenEndpoint,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            const tokens = JSON.parse(data);
            
            // Store session data
            this.sessions.set(sessionId, {
              accessToken: tokens.access_token,
              refreshToken: tokens.refresh_token,
              expiresAt: Date.now() + (tokens.expires_in * 1000),
              authenticated: true
            });

            // Clean up the auth state
            this.authStates.delete(sessionId);
            
            this.log(`✅ Access token obtained for session ${sessionId}`);
            this.log(`🚀 Session ${sessionId} is now authenticated and ready!`);
            resolve();
          } else {
            this.log(`❌ Token exchange failed: ${res.statusCode} ${data}`);
            reject(new Error(`Token exchange failed: ${res.statusCode}`));
          }
        });
      });

      req.on('error', (error) => {
        this.log(`❌ Token exchange error: ${error.message}`);
        reject(error);
      });

      req.write(postData);
      req.end();
    });
  }

  startMCPInterface() {
    this.log('🔌 Starting MCP interface...');
    
    const requestHandler = (req, res) => {
      // Set default headers
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session-ID');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      // Extract or create session ID
      let sessionId = req.headers['x-session-id'];
      if (!sessionId) {
        sessionId = this.generateSessionId();
        this.log(`📝 New session created: ${sessionId}`);
      }

      // Handle authentication initiation
      if (req.url === '/auth/start') {
        if (this.isSessionAuthenticated(sessionId)) {
          res.writeHead(200);
          res.end(JSON.stringify({
            status: 'already_authenticated',
            sessionId,
            message: 'Session already authenticated'
          }));
          return;
        }

        // Check if OAuth is already in progress for this session
        if (this.authStates.has(sessionId)) {
          res.writeHead(200);
          res.end(JSON.stringify({
            status: 'authentication_in_progress',
            sessionId,
            message: 'OAuth flow already started for this session. Complete authentication in your browser.'
          }));
          return;
        }

        // Start OAuth flow for this session
        this.initiateOAuth(sessionId).then((oauthUrl) => {
          res.writeHead(200);
          res.end(JSON.stringify({
            status: 'authentication_started',
            sessionId,
            oauthUrl,
            message: 'Please complete OAuth authentication in your browser'
          }));
        }).catch((error) => {
          this.log(`❌ Error starting OAuth: ${error.message}`);
          res.writeHead(500);
          res.end(JSON.stringify({ error: 'Failed to start authentication' }));
        });
        return;
      }

      // Check authentication status
      if (req.url === '/auth/status') {
        const isAuthenticated = this.isSessionAuthenticated(sessionId);
        res.writeHead(200);
        res.end(JSON.stringify({
          sessionId,
          authenticated: isAuthenticated,
          status: isAuthenticated ? 'authenticated' : 'not_authenticated'
        }));
        return;
      }

      // Handle MCP execution (requires authentication)
      if (req.url === '/execute' && req.method === 'POST') {
        if (!this.isSessionAuthenticated(sessionId)) {
          res.writeHead(401);
          res.end(JSON.stringify({ 
            error: 'Not authenticated',
            sessionId,
            authUrl: '/auth/start',
            message: 'Please authenticate first by visiting /auth/start'
          }));
          return;
        }

        this.handleRemoteExecution(req, res, sessionId);
        return;
      }

      // Default endpoint - auto-trigger OAuth for unauthenticated sessions
      if (!this.isSessionAuthenticated(sessionId)) {
        // Check if OAuth is already in progress for this session
        if (this.authStates.has(sessionId)) {
          res.writeHead(200);
          res.end(JSON.stringify({
            name: 'Remote MCP OAuth Connector',
            version: '1.0.0',
            status: 'authentication_in_progress',
            sessionId,
            message: 'OAuth authentication already started. Please complete login in your browser.',
            endpoints: ['/auth/start', '/auth/status', '/execute']
          }));
          return;
        }

        this.log(`🔄 Auto-triggering OAuth for new session: ${sessionId}`);
        
        // Automatically start OAuth flow for this session
        this.initiateOAuth(sessionId).then((oauthUrl) => {
          res.writeHead(200);
          res.end(JSON.stringify({
            name: 'Remote MCP OAuth Connector',
            version: '1.0.0',
            status: 'authentication_required',
            sessionId,
            action: 'oauth_started',
            oauthUrl,
            message: 'OAuth authentication started automatically. Please complete login in your browser.',
            endpoints: ['/auth/start', '/auth/status', '/execute']
          }));
        }).catch((error) => {
          this.log(`❌ Auto-OAuth error: ${error.message}`);
          res.writeHead(500);
          res.end(JSON.stringify({ 
            error: 'Failed to start automatic authentication',
            sessionId,
            fallback: 'Visit /auth/start manually'
          }));
        });
        return;
      }

      // Authenticated session - return ready status
      res.writeHead(200);
      res.end(JSON.stringify({
        name: 'Remote MCP OAuth Connector',
        version: '1.0.0',
        status: 'authenticated',
        sessionId,
        endpoints: ['/auth/start', '/auth/status', '/execute'],
        message: 'OAuth authenticated - ready for MCP operations'
      }));
    };

    let server;
    if (this.useHttps) {
      try {
        const sslOptions = this.getSSLOptions();
        server = https.createServer(sslOptions, requestHandler);
      } catch (error) {
        this.log(`❌ Failed to create HTTPS MCP interface: ${error.message}`);
        this.log('🔄 Falling back to HTTP...');
        this.useHttps = false;
        server = http.createServer(requestHandler);
      }
    } else {
      server = http.createServer(requestHandler);
    }

    const port = 8848;
    const protocol = this.useHttps ? 'https' : 'http';
    
    server.listen(port, () => {
      this.log(`🎯 MCP interface available at ${protocol}://localhost:${port}`);
      this.log('');
      this.log('🎉 Setup Complete! Add to Claude Desktop:');
      this.log('   1. Open Claude Desktop Settings');
      this.log('   2. Go to "Connectors" or "Add Custom Connector"');
      this.log(`   3. Add: ${protocol}://localhost:${port}`);
      this.log('   4. OAuth authentication will start automatically!');
      this.log('   5. Complete login in browser when prompted');
      if (this.useHttps) {
        this.log('   ⚠️  Accept the self-signed certificate when prompted');
      }
      this.log('');
    });
  }

  async handleRemoteExecution(req, res, sessionId) {
    let body = '';
    req.on('data', (chunk) => body += chunk);
    req.on('end', async () => {
      try {
        const command = JSON.parse(body);
        this.log(`⚡ Executing remote command for session ${sessionId}: ${command.method}`);
        
        const result = await this.executeRemoteCommand(command, sessionId);
        res.end(JSON.stringify(result));
        
      } catch (error) {
        this.log(`❌ Command execution error for session ${sessionId}: ${error.message}`);
        res.writeHead(500);
        res.end(JSON.stringify({ error: error.message }));
      }
    });
  }

  async executeRemoteCommand(command, sessionId) {
    return new Promise((resolve, reject) => {
      const session = this.sessions.get(sessionId);
      if (!session || !session.accessToken) {
        reject(new Error('Session not authenticated'));
        return;
      }

      const mcpRequest = {
        jsonrpc: "2.0",
        id: Date.now(),
        method: command.method || "read_file",
        params: command.params || {}
      };

      const postData = JSON.stringify(mcpRequest);
      const remoteUrl = new URL(this.remoteServerUrl);
      const remoteEndpoint = process.env.REMOTE_DC_SERVER_ENDPOINT || '/api/mcp/execute';
      
      const options = {
        hostname: remoteUrl.hostname,
        port: remoteUrl.port,
        path: remoteEndpoint,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.accessToken}`,
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            const result = JSON.parse(data);
            resolve(result);
          } else {
            reject(new Error(`Remote execution failed: ${res.statusCode} ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.error('\n🛑 Shutting down Remote MCP OAuth Connector...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.error('\n🛑 Shutting down Remote MCP OAuth Connector...');
  process.exit(0);
});

// Start the connector
const connector = new RemoteMCPOAuthConnector();