/**
 * OAuth Request Processing Logic
 * Handles OAuth 2.0 flow processing, PKCE storage, and token generation
 */

import { serverLogger } from '../../utils/logger.js';

// PKCE code storage for validation (in production, use Redis or database)
const pkceCodes = new Map();

export class OAuthProcessor {
  constructor(serverUrl, supabase) {
    this.serverUrl = serverUrl;
    this.supabase = supabase;
  }

  /**
   * Process OAuth authorization request
   */
  processAuthorizationRequest(params) {
    const {
      response_type,
      client_id,
      redirect_uri,
      scope,
      code_challenge,
      code_challenge_method,
      resource
    } = params;

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
    this.cleanupOldPKCECodes();

    // Generate authentication URL
    const authUrl = `${this.serverUrl}/auth.html?${new URLSearchParams({
      response_type,
      client_id,
      redirect_uri,
      scope: scope || 'mcp:tools',
      state: params.state || '',
      code_challenge,
      code_challenge_method,
      resource: resource || this.serverUrl,
      auth_id: authorizationId // Include for PKCE validation
    }).toString()}`;

    serverLogger.info('✅ Processing authorization request', {
      authUrl: authUrl.substring(0, 100) + '...', // Truncate for logging
      authorizationId,
      clientId: client_id
    });

    return { authorizationId, authUrl };
  }

  /**
   * Process OAuth token exchange
   */
  async processTokenExchange(params) {
    const {
      code,
      redirect_uri,
      client_id,
      code_verifier
    } = params;

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
      throw new Error('Invalid authorization code or expired PKCE challenge');
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
      throw new Error('PKCE validation failed');
    }

    // Clean up PKCE data
    pkceCodes.delete(authorizationId);

    // Use the authorization code as access token (from Supabase callback)
    const accessToken = code;

    // Validate token with Supabase
    const { data: { user }, error: userError } = await this.supabase.auth.getUser(accessToken);

    if (userError) {
      serverLogger.warn('❌ Token validation failed', {
        error: userError.message,
        clientId: client_id
      });
      throw new Error('Invalid authorization code');
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

    return { tokenResponse, user };
  }

  /**
   * Process client registration (universal for any MCP client)
   */
  processClientRegistration(params) {
    const { client_name, redirect_uris, scope } = params;

    serverLogger.info('📝 Processing client registration', {
      clientName: client_name,
      redirectUris: redirect_uris,
      scope: scope
    });

    // Normalize redirect URIs to array
    const normalizedRedirectUris = Array.isArray(redirect_uris) ? redirect_uris : [redirect_uris];

    // Detect client type based on redirect URIs
    const clientType = this.determineClientType(normalizedRedirectUris);

    // Generate client credentials for dynamic registration
    const clientId = 'mcp_client_' + Date.now() + '_' + Math.random().toString(36).substring(2);

    const clientInfo = {
      client_id: clientId,
      client_name: client_name,
      redirect_uris: normalizedRedirectUris,
      scope: scope || 'mcp:tools',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: clientType.authMethod,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_secret_expires_at: 0
    };

    // Only generate client_secret for confidential clients
    if (!clientType.isPublic) {
      clientInfo.client_secret = 'secret_' + Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
    }

    serverLogger.info('✅ Dynamic client registration successful', {
      clientId: clientInfo.client_id,
      clientName: clientInfo.client_name,
      clientType: clientType.isPublic ? 'public' : 'confidential',
      redirectUris: clientInfo.redirect_uris
    });

    return clientInfo;
  }

  /**
   * Determine client type from redirect URIs
   * Public clients use out-of-band (OOB) redirect for desktop/mobile apps
   * Confidential clients use HTTP(S) redirects
   */
  determineClientType(redirectUris) {
    // Check if any redirect URI is out-of-band (OOB)
    const hasOOB = redirectUris.some(uri =>
      uri === 'urn:ietf:wg:oauth:2.0:oob' || uri.startsWith('urn:ietf:wg:oauth:2.0:oob')
    );

    return {
      isPublic: hasOOB,
      authMethod: hasOOB ? 'none' : 'client_secret_post'
    };
  }

  /**
   * Process OAuth callback
   */
  async processCallback(params) {
    const {
      access_token,
      refresh_token,
      error,
      error_description,
      client_id,
      redirect_uri,
      state
    } = params;

    serverLogger.info('🔄 Processing OAuth callback', {
      hasAccessToken: !!access_token,
      hasRefreshToken: !!refresh_token,
      error: error,
      clientId: client_id,
      redirectUri: redirect_uri,
      state: state
    });

    if (error) {
      throw new Error(`OAuth callback error: ${error} - ${error_description || 'Unknown error'}`);
    }

    if (!access_token) {
      throw new Error('No access token received from OAuth callback');
    }

    // Verify the Supabase token
    const { data: { user }, error: userError } = await this.supabase.auth.getUser(access_token);

    if (userError) {
      throw new Error(`Token validation failed: ${userError.message}`);
    }

    serverLogger.info('✅ OAuth callback processed successfully', {
      userId: user.id,
      email: user.email,
      clientId: client_id
    });

    // Store session
    // Session storage removed as requested
    // const { error: sessionError } = await this.supabase.from('mcp_sessions')...

    return {
      user,
      access_token,
      refresh_token,
      redirect_uri,
      state,
      token_response: {
        access_token,
        refresh_token,
        token_type: 'Bearer',
        expires_in: 86400
      }
    };
  }

  /**
   * Clean up old PKCE codes (older than 10 minutes)
   */
  cleanupOldPKCECodes() {
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    for (const [id, data] of pkceCodes) {
      if (data.created_at < tenMinutesAgo) {
        pkceCodes.delete(id);
      }
    }
  }

  /**
   * Get PKCE codes count (for monitoring)
   */
  getPKCECodesCount() {
    return pkceCodes.size;
  }
}