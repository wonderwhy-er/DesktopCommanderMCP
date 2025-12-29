/**
 * OAuth Authorization Routes
 * Implements OAuth 2.1 authorization and token endpoints
 */

const express = require('express');
const router = express.Router();

const clientStore = require('../models/oauth-server/models/client.cjs');
const tokenStore = require('../models/oauth-server/models/token.cjs');
const userStore = require('../models/oauth-server/models/user.cjs');
const { getCurrentUser } = require('../config/passport.cjs');
const { 
  validateAuthorizationRequest,
  validateClientCredentials,
  validateTokenRequest,
  validateAuthorizationCodeGrant,
  validateRefreshTokenGrant,
  rateLimit
} = require('../middleware/auth.cjs');
const { 
  validatePkceChallenge,
  validatePkceVerifier,
  logPkceUsage 
} = require('../middleware/pkce.cjs');

/**
 * OAuth Authorization Metadata Endpoint (RFC 8414)
 * GET /.well-known/oauth-authorization-server
 */
router.get('/.well-known/oauth-authorization-server', (req, res) => {
  const baseUrl = process.env.OAUTH_BASE_URL || 'http://localhost:4449';
  
  const metadata = {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`,
    introspection_endpoint: `${baseUrl}/introspect`,
    
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
    
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['openid', 'email', 'profile', 'mcp:tools', 'mcp:admin'],
    
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    
    claims_supported: ['sub', 'email', 'name', 'preferred_username'],
    
    service_documentation: `${baseUrl}/docs`,
    ui_locales_supported: ['en-US'],
    
    // MCP-specific metadata
    mcp_specification_version: '2024-11-05',
    mcp_capabilities: ['tools', 'resources', 'logging'],
    mcp_transport: ['sse', 'http']
  };

  res.json(metadata);
});

/**
 * OAuth Authorization Endpoint
 * GET /authorize
 */
router.get('/authorize', 
  rateLimit(60000, 30), // 30 requests per minute
  logPkceUsage,
  validateAuthorizationRequest,
  validatePkceChallenge,
  async (req, res) => {
    try {
      const user = getCurrentUser(req);
      const { client_id, redirect_uri, scope, state, response_type, code_challenge, code_challenge_method } = req.oauth;
      const client = req.oauth.client;

      // For demo mode, auto-approve
      if (process.env.DEMO_MODE === 'true' && user) {
        console.log(`[OAuth] Auto-approving authorization for demo user: ${user.email}`);
        
        // Generate authorization code
        const authCode = tokenStore.generateAuthorizationCode(
          client_id,
          user.id,
          redirect_uri,
          scope,
          code_challenge,
          code_challenge_method
        );

        // Redirect with authorization code
        const redirectUrl = new URL(redirect_uri);
        redirectUrl.searchParams.set('code', authCode);
        if (state) {
          redirectUrl.searchParams.set('state', state);
        }

        console.log(`[OAuth] Redirecting to: ${redirectUrl.toString()}`);
        return res.redirect(redirectUrl.toString());
      }

      // In production, show consent screen
      res.status(200).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>OAuth Authorization - ${client.client_name}</title>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body { font-family: Arial, sans-serif; max-width: 500px; margin: 50px auto; padding: 20px; }
            .consent-form { border: 1px solid #ddd; padding: 20px; border-radius: 8px; }
            .scopes { margin: 15px 0; }
            .scope { margin: 5px 0; padding: 5px; background: #f5f5f5; border-radius: 4px; }
            .buttons { margin-top: 20px; }
            button { padding: 10px 20px; margin: 5px; border: none; border-radius: 4px; cursor: pointer; }
            .approve { background: #007cba; color: white; }
            .deny { background: #dc3545; color: white; }
            .client-info { background: #e9ecef; padding: 10px; border-radius: 4px; margin-bottom: 15px; }
          </style>
        </head>
        <body>
          <div class="consent-form">
            <h2>🔐 Authorization Request</h2>
            
            <div class="client-info">
              <strong>Application:</strong> ${client.client_name}<br>
              <strong>Client ID:</strong> ${client_id}
            </div>

            <p>This application is requesting access to your account with the following permissions:</p>
            
            <div class="scopes">
              ${scope.split(' ').map(s => `<div class="scope">📋 ${s}</div>`).join('')}
            </div>

            <form method="post" action="/authorize">
              <input type="hidden" name="client_id" value="${client_id}">
              <input type="hidden" name="redirect_uri" value="${redirect_uri}">
              <input type="hidden" name="scope" value="${scope}">
              <input type="hidden" name="state" value="${state}">
              <input type="hidden" name="response_type" value="${response_type}">
              <input type="hidden" name="code_challenge" value="${code_challenge || ''}">
              <input type="hidden" name="code_challenge_method" value="${code_challenge_method || ''}">
              
              <div class="buttons">
                <button type="submit" name="decision" value="approve" class="approve">
                  ✅ Approve
                </button>
                <button type="submit" name="decision" value="deny" class="deny">
                  ❌ Deny
                </button>
              </div>
            </form>
          </div>
        </body>
        </html>
      `);

    } catch (error) {
      console.error('[OAuth] Authorization error:', error);
      res.status(500).json({
        error: 'server_error',
        error_description: 'Internal server error'
      });
    }
  }
);

/**
 * OAuth Authorization Consent Handler
 * POST /authorize
 */
router.post('/authorize',
  validateAuthorizationRequest,
  validatePkceChallenge,
  async (req, res) => {
    try {
      const user = getCurrentUser(req);
      if (!user) {
        return res.status(401).json({
          error: 'access_denied',
          error_description: 'User authentication required'
        });
      }

      const { client_id, redirect_uri, scope, state, code_challenge, code_challenge_method } = req.body;
      const { decision } = req.body;

      const redirectUrl = new URL(redirect_uri);

      if (decision !== 'approve') {
        // User denied authorization
        redirectUrl.searchParams.set('error', 'access_denied');
        redirectUrl.searchParams.set('error_description', 'User denied the authorization request');
        if (state) {
          redirectUrl.searchParams.set('state', state);
        }
        return res.redirect(redirectUrl.toString());
      }

      // User approved - generate authorization code
      const authCode = tokenStore.generateAuthorizationCode(
        client_id,
        user.id,
        redirect_uri,
        scope,
        code_challenge,
        code_challenge_method
      );

      // Redirect with authorization code
      redirectUrl.searchParams.set('code', authCode);
      if (state) {
        redirectUrl.searchParams.set('state', state);
      }

      console.log(`[OAuth] User ${user.email} approved authorization for ${client_id}`);
      res.redirect(redirectUrl.toString());

    } catch (error) {
      console.error('[OAuth] Consent handling error:', error);
      
      const redirectUrl = new URL(req.body.redirect_uri);
      redirectUrl.searchParams.set('error', 'server_error');
      redirectUrl.searchParams.set('error_description', 'Internal server error');
      if (req.body.state) {
        redirectUrl.searchParams.set('state', req.body.state);
      }
      
      res.redirect(redirectUrl.toString());
    }
  }
);

/**
 * OAuth Token Endpoint
 * POST /token
 */
router.post('/token',
  rateLimit(60000, 100), // 100 requests per minute
  validateClientCredentials,
  validateTokenRequest,
  validateAuthorizationCodeGrant,
  validateRefreshTokenGrant,
  async (req, res) => {
    try {
      const { grant_type, client_id } = req.oauth;

      if (grant_type === 'authorization_code') {
        return handleAuthorizationCodeGrant(req, res);
      } else if (grant_type === 'refresh_token') {
        return handleRefreshTokenGrant(req, res);
      }

      res.status(400).json({
        error: 'unsupported_grant_type',
        error_description: `Grant type ${grant_type} is not supported`
      });

    } catch (error) {
      console.error('[OAuth] Token endpoint error:', error);
      res.status(500).json({
        error: 'server_error',
        error_description: 'Internal server error'
      });
    }
  }
);

/**
 * Handle authorization code grant
 */
async function handleAuthorizationCodeGrant(req, res) {
  const { code, client_id, redirect_uri, code_verifier } = req.oauth;

  try {
    // Validate authorization code
    const authData = tokenStore.validateAuthorizationCode(code, client_id, redirect_uri, code_verifier);
    
    // Generate access token
    const accessTokenData = tokenStore.generateAccessToken(
      authData.client_id,
      authData.user_id,
      authData.scope
    );

    // Generate refresh token
    const refreshTokenData = tokenStore.generateRefreshToken(
      authData.client_id,
      authData.user_id,
      authData.scope
    );

    console.log(`[OAuth] Issued access token for user ${authData.user_id}, client ${client_id}`);

    res.json({
      ...accessTokenData,
      ...refreshTokenData
    });

  } catch (error) {
    console.error('[OAuth] Authorization code grant error:', error);
    res.status(400).json({
      error: 'invalid_grant',
      error_description: error.message
    });
  }
}

/**
 * Handle refresh token grant
 */
async function handleRefreshTokenGrant(req, res) {
  const { refresh_token, client_id } = req.oauth;

  try {
    const tokenData = tokenStore.refreshAccessToken(refresh_token, client_id);
    
    console.log(`[OAuth] Refreshed access token for client ${client_id}`);
    
    res.json(tokenData);

  } catch (error) {
    console.error('[OAuth] Refresh token grant error:', error);
    res.status(400).json({
      error: 'invalid_grant',
      error_description: error.message
    });
  }
}

module.exports = router;