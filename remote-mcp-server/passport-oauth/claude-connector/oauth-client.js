/**
 * OAuth Client Logic for MCP Claude Desktop Integration
 */

import crypto from 'crypto';
import http from 'http';
import { exec } from 'child_process';
import fetch from 'cross-fetch';

class MCPOAuthClient {
  constructor(options = {}) {
    // OAuth server configuration
    this.oauthServerUrl = options.oauthServerUrl || process.env.OAUTH_BASE_URL || 'http://localhost:4449';
    this.mcpServerUrl = options.mcpServerUrl || process.env.MCP_BASE_URL || 'http://localhost:3006';
    
    // Client configuration
    this.clientName = options.clientName || 'Claude Desktop MCP Client';
    this.callbackPort = options.callbackPort || 8847;
    this.scopes = options.scopes || 'openid email profile mcp:tools';
    
    // State
    this.clientInfo = null;
    this.accessToken = null;
    this.refreshToken = null;
    this.tokenExpiry = null;
    
    console.error(`[OAuth Client] Initialized for server: ${this.oauthServerUrl}`);
  }

  /**
   * Perform complete OAuth flow
   */
  async authenticate() {
    try {
      console.error('[OAuth Client] Starting OAuth authentication flow...');
      
      // 1. Register OAuth client
      this.clientInfo = await this.registerClient();
      console.error(`[OAuth Client] Client registered: ${this.clientInfo.client_id}`);
      
      // 2. Generate PKCE parameters
      const pkceParams = this.generatePKCE();
      console.error('[OAuth Client] PKCE parameters generated');
      
      // 3. Get authorization code
      const authCode = await this.getAuthorizationCode(pkceParams);
      console.error('[OAuth Client] Authorization code obtained');
      
      // 4. Exchange code for tokens
      const tokens = await this.exchangeCodeForTokens(authCode, pkceParams);
      
      this.accessToken = tokens.access_token;
      this.refreshToken = tokens.refresh_token;
      this.tokenExpiry = Date.now() + (tokens.expires_in * 1000);
      
      console.error('[OAuth Client] ✅ OAuth authentication completed successfully');
      return true;
      
    } catch (error) {
      console.error('[OAuth Client] ❌ OAuth authentication failed:', error.message);
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
   * Get authorization code via browser flow
   */
  async getAuthorizationCode(pkceParams) {
    return new Promise((resolve, reject) => {
      // Create callback server
      const server = http.createServer((req, res) => {
        if (req.url?.startsWith('/callback')) {
          const url = new URL(req.url, `http://localhost:${this.callbackPort}`);
          const code = url.searchParams.get('code');
          const state = url.searchParams.get('state');
          const error = url.searchParams.get('error');

          if (error) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(`<html><body><h1>❌ OAuth Error</h1><p>${error}</p></body></html>`);
            server.close();
            reject(new Error(`OAuth error: ${error}`));
            return;
          }

          if (!code || state !== pkceParams.state) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end('<html><body><h1>❌ Invalid OAuth Response</h1></body></html>');
            server.close();
            reject(new Error('Invalid OAuth callback'));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
                <h1>✅ Authentication Successful</h1>
                <p>Claude Desktop MCP is now authenticated!</p>
                <p>You can close this window and return to Claude Desktop.</p>
              </body>
            </html>
          `);
          
          server.close();
          resolve(code);
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      server.listen(this.callbackPort, () => {
        console.error(`[OAuth Client] Callback server listening on port ${this.callbackPort}`);
        
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
        
        console.error('[OAuth Client] 🌐 Opening browser for authentication...');
        console.error(`[OAuth Client] Auth URL: ${authUrl}`);
        
        // Open browser
        const openCommand = process.platform === 'darwin' ? 'open' : 
                           process.platform === 'win32' ? 'start' : 'xdg-open';
        
        exec(`${openCommand} "${authUrl}"`, (error) => {
          if (error) {
            console.error(`[OAuth Client] ⚠️ Could not open browser: ${error.message}`);
            console.error(`[OAuth Client] Please manually open: ${authUrl}`);
          } else {
            console.error('[OAuth Client] ✅ Browser opened for OAuth login');
          }
        });
      });

      // Timeout after 10 minutes
      setTimeout(() => {
        server.close();
        reject(new Error('OAuth flow timeout after 10 minutes'));
      }, 10 * 60 * 1000);
    });
  }

  /**
   * Exchange authorization code for tokens
   */
  async exchangeCodeForTokens(authCode, pkceParams) {
    const tokenData = new URLSearchParams({
      grant_type: 'authorization_code',
      code: authCode,
      redirect_uri: `http://localhost:${this.callbackPort}/callback`,
      client_id: this.clientInfo.client_id,
      client_secret: this.clientInfo.client_secret,
      code_verifier: pkceParams.code_verifier
    });

    const response = await fetch(`${this.oauthServerUrl}/token`, {
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

  /**
   * Refresh access token if needed
   */
  async ensureValidToken() {
    if (!this.accessToken) {
      throw new Error('No access token available. Please authenticate first.');
    }

    // Check if token is expired (with 60 second buffer)
    if (Date.now() >= (this.tokenExpiry - 60000)) {
      console.error('[OAuth Client] Token expired, refreshing...');
      await this.refreshAccessToken();
    }

    return this.accessToken;
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshAccessToken() {
    if (!this.refreshToken) {
      throw new Error('No refresh token available. Please re-authenticate.');
    }

    const tokenData = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
      client_id: this.clientInfo.client_id,
      client_secret: this.clientInfo.client_secret
    });

    const response = await fetch(`${this.oauthServerUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenData
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token refresh failed: ${response.status} - ${error}`);
    }

    const tokens = await response.json();
    
    this.accessToken = tokens.access_token;
    if (tokens.refresh_token) {
      this.refreshToken = tokens.refresh_token;
    }
    this.tokenExpiry = Date.now() + (tokens.expires_in * 1000);
    
    console.error('[OAuth Client] ✅ Access token refreshed');
    return this.accessToken;
  }

  /**
   * Make authenticated request to MCP server
   */
  async makeAuthenticatedRequest(method, endpoint, data = null) {
    const token = await this.ensureValidToken();
    
    const options = {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    };

    if (data) {
      options.body = JSON.stringify(data);
    }

    const response = await fetch(`${this.mcpServerUrl}${endpoint}`, options);
    
    if (!response.ok) {
      throw new Error(`MCP request failed: ${response.status} ${response.statusText}`);
    }

    return await response.json();
  }

  /**
   * Get available tools from MCP server
   */
  async getTools() {
    return await this.makeAuthenticatedRequest('GET', '/tools');
  }

  /**
   * Execute MCP method
   */
  async executeMethod(method, params = {}) {
    const mcpRequest = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: method,
      params: params
    };

    return await this.makeAuthenticatedRequest('POST', '/message', mcpRequest);
  }

  /**
   * Call tool on MCP server
   */
  async callTool(toolName, args = {}) {
    return await this.executeMethod('tools/call', {
      name: toolName,
      arguments: args
    });
  }

  /**
   * Check if currently authenticated
   */
  isAuthenticated() {
    return this.accessToken && Date.now() < (this.tokenExpiry - 60000);
  }

  /**
   * Get authentication status
   */
  getStatus() {
    return {
      authenticated: this.isAuthenticated(),
      client_id: this.clientInfo?.client_id,
      token_expires_at: this.tokenExpiry,
      time_until_expiry: this.tokenExpiry ? Math.max(0, this.tokenExpiry - Date.now()) : 0,
      oauth_server: this.oauthServerUrl,
      mcp_server: this.mcpServerUrl
    };
  }
}

export default MCPOAuthClient;