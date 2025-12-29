/**
 * OAuth Client Model
 * In-memory storage for OAuth clients with simple persistence option
 */

const { v4: uuidv4 } = require('uuid');

class ClientStore {
  constructor() {
    this.clients = new Map();
    this.preregisteredClients = new Map();
    
    // Add default client for development
    this.addPreregisteredClient({
      client_id: process.env.DEFAULT_CLIENT_ID || 'mcp-client',
      client_secret: process.env.DEFAULT_CLIENT_SECRET || 'mcp-secret',
      client_name: 'Default MCP Client',
      redirect_uris: [process.env.DEFAULT_REDIRECT_URI || 'http://localhost:8847/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: process.env.DEFAULT_SCOPES || 'openid email profile mcp:tools',
      created_at: new Date().toISOString()
    });

    // Add Claude Desktop pre-configured client with official callback URLs
    this.addPreregisteredClient({
      client_id: 'claude-desktop-remote',
      client_secret: process.env.CLAUDE_CLIENT_SECRET || 'claude-remote-secret-change-in-production',
      client_name: 'Claude Desktop Remote Connector',
      redirect_uris: [
        'https://claude.ai/api/mcp/auth_callback',
        'https://claude.com/api/mcp/auth_callback'
      ],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'openid email profile mcp:tools mcp:admin',
      created_at: new Date().toISOString()
    });

    // Add demo client for testing authorization flow
    if (process.env.DEMO_MODE === 'true') {
      this.addPreregisteredClient({
        client_id: 'mcp-demo-client',
        client_secret: 'demo-secret-123',
        client_name: 'MCP Demo Client',
        redirect_uris: [
          'http://localhost:3006/oauth/callback',
          'http://localhost:3005/oauth/callback', 
          'http://localhost:8847/callback'
        ],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: 'openid email profile mcp:tools mcp:admin',
        created_at: new Date().toISOString()
      });
    }
  }

  /**
   * Add a pre-registered client (for development/testing)
   */
  addPreregisteredClient(clientData) {
    const client = {
      client_id: clientData.client_id,
      client_secret: clientData.client_secret,
      client_name: clientData.client_name,
      redirect_uris: clientData.redirect_uris,
      grant_types: clientData.grant_types || ['authorization_code'],
      response_types: clientData.response_types || ['code'],
      scope: clientData.scope,
      token_endpoint_auth_method: 'client_secret_post',
      created_at: clientData.created_at || new Date().toISOString(),
      preregistered: true
    };
    
    this.preregisteredClients.set(client.client_id, client);
    this.clients.set(client.client_id, client);
    return client;
  }

  /**
   * Register a new OAuth client (RFC 7591)
   */
  registerClient(registrationRequest) {
    const client_id = uuidv4();
    const client_secret = this.generateClientSecret();
    
    const client = {
      client_id,
      client_secret,
      client_name: registrationRequest.client_name || 'Unnamed Client',
      redirect_uris: registrationRequest.redirect_uris || [],
      grant_types: registrationRequest.grant_types || ['authorization_code'],
      response_types: registrationRequest.response_types || ['code'],
      scope: registrationRequest.scope || 'openid',
      token_endpoint_auth_method: registrationRequest.token_endpoint_auth_method || 'client_secret_post',
      created_at: new Date().toISOString(),
      preregistered: false
    };

    // Validate redirect URIs
    if (!client.redirect_uris || client.redirect_uris.length === 0) {
      throw new Error('At least one redirect_uri is required');
    }

    // Allowlist for Claude's official callback URLs and localhost for development
    const allowedCallbackPatterns = [
      // Claude's official Remote MCP Connector callbacks
      'https://claude.ai/api/mcp/auth_callback',
      'https://claude.com/api/mcp/auth_callback',
      
      // Localhost patterns for development
      /^http:\/\/localhost:\d+\/.*$/,
      /^http:\/\/127\.0\.0\.1:\d+\/.*$/,
      /^http:\/\/\[::1\]:\d+\/.*$/,
      
      // HTTPS localhost for development (if using self-signed certs)
      /^https:\/\/localhost:\d+\/.*$/,
      /^https:\/\/127\.0\.0\.1:\d+\/.*$/,
      /^https:\/\/\[::1\]:\d+\/.*$/
    ];

    // Validate each redirect URI against allowlist
    for (const redirectUri of client.redirect_uris) {
      const isAllowed = allowedCallbackPatterns.some(pattern => {
        if (typeof pattern === 'string') {
          return redirectUri === pattern;
        } else if (pattern instanceof RegExp) {
          return pattern.test(redirectUri);
        }
        return false;
      });

      if (!isAllowed) {
        throw new Error(`Redirect URI not allowed: ${redirectUri}. Must be Claude's official callback URL or localhost for development.`);
      }
    }

    console.log(`[OAuth] ✅ Validated redirect URIs for client ${client.client_name}:`, client.redirect_uris);

    // Validate grant types
    const supportedGrantTypes = ['authorization_code', 'refresh_token'];
    const invalidGrantTypes = client.grant_types.filter(type => !supportedGrantTypes.includes(type));
    if (invalidGrantTypes.length > 0) {
      throw new Error(`Unsupported grant types: ${invalidGrantTypes.join(', ')}`);
    }

    this.clients.set(client_id, client);
    return client;
  }

  /**
   * Get client by ID
   */
  getClient(client_id) {
    return this.clients.get(client_id);
  }

  /**
   * Validate client credentials
   */
  validateClient(client_id, client_secret) {
    const client = this.getClient(client_id);
    if (!client) {
      return false;
    }
    
    return client.client_secret === client_secret;
  }

  /**
   * Validate redirect URI for client
   */
  validateRedirectUri(client_id, redirect_uri) {
    const client = this.getClient(client_id);
    if (!client) {
      return false;
    }
    
    return client.redirect_uris.includes(redirect_uri);
  }

  /**
   * Generate secure client secret
   */
  generateClientSecret() {
    const crypto = require('crypto');
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Get all clients (for admin purposes)
   */
  getAllClients() {
    return Array.from(this.clients.values());
  }

  /**
   * Delete a client
   */
  deleteClient(client_id) {
    return this.clients.delete(client_id);
  }

  /**
   * Get client registration info (public data only)
   */
  getClientRegistrationInfo(client_id) {
    const client = this.getClient(client_id);
    if (!client) {
      return null;
    }

    // Return public information only (no client_secret)
    return {
      client_id: client.client_id,
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      grant_types: client.grant_types,
      response_types: client.response_types,
      scope: client.scope,
      token_endpoint_auth_method: client.token_endpoint_auth_method,
      created_at: client.created_at
    };
  }
}

// Export singleton instance
module.exports = new ClientStore();