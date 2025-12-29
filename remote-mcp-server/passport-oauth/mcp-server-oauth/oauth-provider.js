/**
 * OAuth Provider Adapter for Passport OAuth Server
 * Bridges MCP SDK's mcpAuthRouter with our existing OAuth 2.1 server
 */

import crypto from 'crypto';
import fetch from 'cross-fetch';

export class PassportOAuthProvider {
  constructor(options = {}) {
    // OAuth server configuration - uses existing passport-oauth server
    this.oauthServerUrl = options.oauthServerUrl || process.env.OAUTH_BASE_URL || 'http://localhost:4449';
    this.mcpServerUrl = options.mcpServerUrl || process.env.MCP_BASE_URL || 'http://localhost:3005';
    
    // Client configuration for MCP
    this.clientMetadata = {
      client_name: 'MCP Server OAuth Client',
      redirect_uris: [`${this.mcpServerUrl}/oauth/callback`],
      response_types: ['code'],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'client_secret_post',
      scope: 'openid email profile mcp:tools'
    };
    
    // In-memory storage for demo (use database in production)
    this.tokens = new Map(); // tokenId -> tokenData
    this.codes = new Map();  // code -> authData
    this.clients = new Map(); // clientId -> clientData
    this.registeredClient = null;
    
    console.log(`[OAuth Provider] Initialized for OAuth server: ${this.oauthServerUrl}`);
  }

  /**
   * Register this MCP server as an OAuth client
   */
  async ensureClientRegistered() {
    if (this.registeredClient) {
      return this.registeredClient;
    }

    try {
      console.log('[OAuth Provider] Registering MCP server as OAuth client...');
      
      const response = await fetch(`${this.oauthServerUrl}/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(this.clientMetadata)
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Client registration failed: ${response.status} - ${error}`);
      }

      this.registeredClient = await response.json();
      console.log(`[OAuth Provider] Client registered: ${this.registeredClient.client_id}`);
      
      return this.registeredClient;
    } catch (error) {
      console.error('[OAuth Provider] Client registration error:', error);
      throw error;
    }
  }

  /**
   * Initiate OAuth authorization flow
   * Called by MCP SDK when authentication is required
   */
  async authorize(client, params, res) {
    try {
      // Ensure our OAuth client is registered
      const oauthClient = await this.ensureClientRegistered();
      
      // Generate authorization code and state
      const code = crypto.randomUUID();
      const state = crypto.randomBytes(32).toString('hex');
      
      // Generate PKCE parameters
      const codeVerifier = crypto.randomBytes(32).toString('base64url');
      const codeChallenge = crypto
        .createHash('sha256')
        .update(codeVerifier)
        .digest('base64url');

      // Store authorization data
      this.codes.set(code, {
        client_id: client.client_id,
        redirect_uri: params.redirectUri,
        scope: params.scopes?.join(' ') || 'mcp:tools',
        code_challenge: codeChallenge,
        code_verifier: codeVerifier,
        state: state,
        createdAt: Date.now()
      });

      // Build authorization URL for our OAuth server
      const authUrl = new URL(`${this.oauthServerUrl}/authorize`);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', oauthClient.client_id);
      authUrl.searchParams.set('redirect_uri', `${this.mcpServerUrl}/oauth/callback`);
      authUrl.searchParams.set('scope', 'openid email profile mcp:tools');
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');

      console.log(`[OAuth Provider] Redirecting to authorization server: ${authUrl.toString()}`);
      
      // Redirect to OAuth server
      res.redirect(authUrl.toString());

    } catch (error) {
      console.error('[OAuth Provider] Authorization error:', error);
      res.status(500).json({
        error: 'server_error',
        error_description: error.message
      });
    }
  }

  /**
   * Get PKCE challenge for authorization code
   */
  async challengeForAuthorizationCode(client, authorizationCode) {
    const codeData = this.codes.get(authorizationCode);
    if (!codeData) {
      throw new Error('Invalid authorization code');
    }
    return codeData.code_challenge;
  }

  /**
   * Exchange authorization code for access token
   */
  async exchangeAuthorizationCode(client, authorizationCode, codeVerifier) {
    try {
      const codeData = this.codes.get(authorizationCode);
      
      if (!codeData) {
        throw new Error('Invalid authorization code');
      }

      // Verify PKCE code verifier
      const expectedChallenge = crypto
        .createHash('sha256')
        .update(codeVerifier)
        .digest('base64url');
      
      if (codeData.code_challenge !== expectedChallenge) {
        throw new Error('Invalid code verifier');
      }

      // Get registered OAuth client
      const oauthClient = await this.ensureClientRegistered();

      // Exchange code for tokens with our OAuth server
      const tokenResponse = await fetch(`${this.oauthServerUrl}/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: oauthClient.client_id,
          client_secret: oauthClient.client_secret,
          code: authorizationCode,
          redirect_uri: `${this.mcpServerUrl}/oauth/callback`,
          code_verifier: codeVerifier
        })
      });

      if (!tokenResponse.ok) {
        const error = await tokenResponse.text();
        throw new Error(`Token exchange failed: ${tokenResponse.status} - ${error}`);
      }

      const tokens = await tokenResponse.json();
      
      // Generate token ID for MCP SDK
      const tokenId = crypto.randomUUID();
      
      // Store token data
      this.tokens.set(tokenId, {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_in: tokens.expires_in,
        scope: codeData.scope,
        client_id: client.client_id,
        created_at: Date.now()
      });

      // Clean up authorization code
      this.codes.delete(authorizationCode);

      console.log(`[OAuth Provider] Token exchange successful for client: ${client.client_id}`);

      return {
        access_token: tokenId, // MCP SDK expects our token ID
        token_type: 'Bearer',
        expires_in: tokens.expires_in,
        scope: codeData.scope
      };

    } catch (error) {
      console.error('[OAuth Provider] Token exchange error:', error);
      throw error;
    }
  }

  /**
   * Validate access token via OAuth introspection
   * Called by MCP SDK for each authenticated request
   */
  async validateToken(accessToken) {
    try {
      console.log(`[OAuth Provider] 🔍 Validating token with OAuth server: ${accessToken.substring(0, 20)}...`);
      
      // Use OAuth introspection endpoint to validate token
      const introspectionResponse = await fetch(`${this.oauthServerUrl}/introspect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `token=${encodeURIComponent(accessToken)}`
      });

      if (!introspectionResponse.ok) {
        console.error('[OAuth Provider] ❌ Token introspection failed:', introspectionResponse.status);
        throw new Error('Token introspection failed');
      }

      const introspectionResult = await introspectionResponse.json();
      console.log('[OAuth Provider] 📋 Introspection result:', introspectionResult);
      
      if (!introspectionResult.active) {
        console.log('[OAuth Provider] ❌ Token is not active');
        throw new Error('Token is not active');
      }

      // Return token info in expected format
      const tokenInfo = {
        sub: introspectionResult.sub,
        client_id: introspectionResult.client_id,
        scope: introspectionResult.scope,
        exp: introspectionResult.exp,
        iat: introspectionResult.iat,
        active: introspectionResult.active
      };
      
      console.log('[OAuth Provider] ✅ Token validated successfully for user:', introspectionResult.sub);
      return tokenInfo;

    } catch (error) {
      console.error('[OAuth Provider] Token validation error:', error);
      throw error;
    }
  }

  /**
   * Refresh access token
   */
  async refreshToken(tokenId) {
    try {
      const tokenData = this.tokens.get(tokenId);
      
      if (!tokenData || !tokenData.refresh_token) {
        throw new Error('Invalid refresh token');
      }

      const oauthClient = await this.ensureClientRegistered();

      const refreshResponse = await fetch(`${this.oauthServerUrl}/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: tokenData.refresh_token,
          client_id: oauthClient.client_id,
          client_secret: oauthClient.client_secret
        })
      });

      if (!refreshResponse.ok) {
        throw new Error('Token refresh failed');
      }

      const newTokens = await refreshResponse.json();

      // Update stored token data
      this.tokens.set(tokenId, {
        ...tokenData,
        access_token: newTokens.access_token,
        refresh_token: newTokens.refresh_token || tokenData.refresh_token,
        expires_in: newTokens.expires_in,
        created_at: Date.now()
      });

      console.log(`[OAuth Provider] Token refreshed for client: ${tokenData.client_id}`);

      return await this.validateToken(tokenId);

    } catch (error) {
      console.error('[OAuth Provider] Token refresh error:', error);
      this.tokens.delete(tokenId);
      throw error;
    }
  }

  /**
   * Handle OAuth callback from authorization server
   */
  async handleCallback(req, res) {
    try {
      const { code, state, error } = req.query;

      if (error) {
        return res.status(400).json({
          error: error,
          error_description: req.query.error_description || 'OAuth authorization failed'
        });
      }

      if (!code || !state) {
        return res.status(400).json({
          error: 'invalid_request',
          error_description: 'Missing authorization code or state'
        });
      }

      // Find the authorization data by state
      let authData = null;
      for (const [authCode, data] of this.codes.entries()) {
        if (data.state === state) {
          authData = { code: authCode, ...data };
          break;
        }
      }

      if (!authData) {
        return res.status(400).json({
          error: 'invalid_state',
          error_description: 'Invalid state parameter'
        });
      }

      // Store the actual authorization code from OAuth server
      this.codes.set(code, authData);
      this.codes.delete(authData.code);

      res.json({
        success: true,
        message: 'Authorization successful. You can close this window.'
      });

    } catch (error) {
      console.error('[OAuth Provider] Callback error:', error);
      res.status(500).json({
        error: 'server_error',
        error_description: error.message
      });
    }
  }

  /**
   * Get provider metadata for MCP authorization discovery
   */
  getMetadata() {
    return {
      authorization_server: this.oauthServerUrl,
      authorization_endpoint: `${this.oauthServerUrl}/authorize`,
      token_endpoint: `${this.oauthServerUrl}/token`,
      registration_endpoint: `${this.oauthServerUrl}/register`,
      introspection_endpoint: `${this.oauthServerUrl}/introspect`,
      scopes_supported: ['openid', 'email', 'profile', 'mcp:tools', 'mcp:admin'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
      code_challenge_methods_supported: ['S256'],
      pkce_required: true
    };
  }
}