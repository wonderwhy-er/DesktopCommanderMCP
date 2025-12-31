/**
 * OAuth Response Handling Utilities
 * Handles OAuth 2.0 response generation and endpoint routing
 */

import { serverLogger } from '../../utils/logger.js';

export class OAuthResponder {
  constructor(serverUrl) {
    this.serverUrl = serverUrl;
  }

  /**
   * Generate OAuth discovery response
   */
  generateDiscoveryResponse() {
    serverLogger.info('🔍 Generating OAuth discovery response', {
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

    serverLogger.info('✅ OAuth discovery response generated', {
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

    return discovery;
  }

  /**
   * Generate protected resource discovery response
   */
  generateProtectedResourceResponse() {
    serverLogger.info('🛡️ Generating protected resource discovery response', {
      serverUrl: this.serverUrl
    });

    const resourceInfo = {
      resource_server: this.serverUrl,
      authorization_servers: [this.serverUrl],
      scopes_supported: ['mcp:tools'],
      bearer_methods_supported: ['header'],
      resource_documentation: `${this.serverUrl}/docs`
    };

    serverLogger.info('✅ Protected resource discovery response generated', {
      resourceServer: resourceInfo.resource_server,
      scopes: resourceInfo.scopes_supported,
      bearerMethods: resourceInfo.bearer_methods_supported
    });

    return resourceInfo;
  }

  /**
   * Send error response with proper OAuth error format
   */
  sendErrorResponse(res, error, errorDescription, statusCode = 400) {
    serverLogger.warn(`❌ OAuth error: ${error}`, {
      error,
      errorDescription,
      statusCode
    });

    return res.status(statusCode).json({
      error,
      error_description: errorDescription
    });
  }

  /**
   * Send redirect response for authorization flow
   */
  sendRedirectResponse(res, redirectUrl) {
    serverLogger.info('🔄 Sending OAuth redirect', {
      redirectUrl: redirectUrl.substring(0, 100) + '...' // Truncate for logging
    });

    return res.redirect(redirectUrl);
  }

  /**
   * Send successful token response
   */
  sendTokenResponse(res, tokenData) {
    serverLogger.info('✅ Sending token response', {
      tokenType: tokenData.token_type,
      expiresIn: tokenData.expires_in,
      scope: tokenData.scope,
      hasResource: !!tokenData.resource
    });

    return res.json(tokenData);
  }

  /**
   * Send client registration response
   */
  sendRegistrationResponse(res, clientInfo) {
    serverLogger.info('📝 Sending client registration response', {
      clientId: clientInfo.client_id,
      clientName: clientInfo.client_name,
      redirectUris: clientInfo.redirect_uris,
      hasClientSecret: !!clientInfo.client_secret
    });

    return res.json(clientInfo);
  }

  /**
   * Handle callback redirect with success/error
   */
  handleCallbackRedirect(res, result) {
    const { redirect_uri, state, error, error_description, access_token, refresh_token } = result;

    if (!redirect_uri) {
      // No redirect URI, send JSON response
      if (error) {
        return this.sendErrorResponse(res, error, error_description);
      }

      return res.json({
        access_token,
        refresh_token,
        token_type: 'Bearer',
        expires_in: 86400
      });
    }

    // Handle redirect URI
    try {
      const redirectUrl = new URL(redirect_uri);

      if (error) {
        redirectUrl.searchParams.set('error', error);
        if (error_description) {
          redirectUrl.searchParams.set('error_description', error_description);
        }
        if (state) {
          redirectUrl.searchParams.set('state', state);
        }
      } else {
        // For agent authentication, send as access_token for better compatibility
        redirectUrl.searchParams.set('access_token', access_token);
        if (refresh_token) {
          redirectUrl.searchParams.set('refresh_token', refresh_token);
        }
        redirectUrl.searchParams.set('code', access_token); // Backward compatibility
        if (state) {
          redirectUrl.searchParams.set('state', state);
        }
      }

      return this.sendRedirectResponse(res, redirectUrl.toString());

    } catch (urlError) {
      serverLogger.error('Invalid redirect URI', { redirect_uri }, urlError);
      return this.sendErrorResponse(res, 'invalid_request', 'Invalid redirect_uri format');
    }
  }

  /**
   * Generate MCP info response
   */
  generateMCPInfoResponse() {
    const mcpInfo = {
      mcpServerUrl: this.serverUrl,
      supabaseUrl: process.env.SUPABASE_URL,
      supabaseAnonKey: process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY,
      redirectUrl: `${this.serverUrl}/auth/callback`,
      authorizationEndpoint: `${this.serverUrl}/authorize`,
      tokenEndpoint: `${this.serverUrl}/token`,
      discoveryEndpoint: `${this.serverUrl}/.well-known/oauth-authorization-server`
    };

    serverLogger.info('✅ MCP info response generated', {
      mcpServerUrl: mcpInfo.mcpServerUrl,
      redirectUrl: mcpInfo.redirectUrl,
      hasSupabaseConfig: !!(mcpInfo.supabaseUrl && mcpInfo.supabaseAnonKey)
    });

    return mcpInfo;
  }
}