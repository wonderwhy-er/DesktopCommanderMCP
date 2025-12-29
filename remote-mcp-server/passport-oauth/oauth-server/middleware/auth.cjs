/**
 * Authentication Middleware
 * Additional auth utilities for OAuth server
 */

const clientStore = require('../models/oauth-server/models/client.cjs');
const tokenStore = require('../models/oauth-server/models/token.cjs');

/**
 * Validate OAuth parameters in authorization request
 */
function validateAuthorizationRequest(req, res, next) {
  const {
    response_type,
    client_id,
    redirect_uri,
    scope,
    state
  } = req.query;

  // Check required parameters
  if (!response_type) {
    return res.status(400).json({
      error: 'invalid_request',
      error_description: 'response_type parameter is required'
    });
  }

  if (!client_id) {
    return res.status(400).json({
      error: 'invalid_request',
      error_description: 'client_id parameter is required'
    });
  }

  if (!redirect_uri) {
    return res.status(400).json({
      error: 'invalid_request',
      error_description: 'redirect_uri parameter is required'
    });
  }

  // Validate response_type
  const supportedResponseTypes = ['code'];
  if (!supportedResponseTypes.includes(response_type)) {
    return res.status(400).json({
      error: 'unsupported_response_type',
      error_description: `Supported response types: ${supportedResponseTypes.join(', ')}`
    });
  }

  // Validate client
  const client = clientStore.getClient(client_id);
  if (!client) {
    return res.status(400).json({
      error: 'invalid_client',
      error_description: 'Invalid client_id'
    });
  }

  // Validate redirect URI
  if (!clientStore.validateRedirectUri(client_id, redirect_uri)) {
    return res.status(400).json({
      error: 'invalid_request',
      error_description: 'Invalid redirect_uri for this client'
    });
  }

  // Validate response_type is supported by client
  if (!client.response_types.includes(response_type)) {
    return res.status(400).json({
      error: 'unauthorized_client',
      error_description: 'Client is not authorized for this response_type'
    });
  }

  // Attach validated data to request
  req.oauth = {
    response_type,
    client_id,
    client,
    redirect_uri,
    scope: scope || '',
    state: state || ''
  };

  next();
}

/**
 * Validate client credentials for token endpoint
 */
function validateClientCredentials(req, res, next) {
  const { client_id, client_secret } = req.body;

  if (!client_id) {
    return res.status(400).json({
      error: 'invalid_request',
      error_description: 'client_id is required'
    });
  }

  if (!client_secret) {
    return res.status(400).json({
      error: 'invalid_request',
      error_description: 'client_secret is required'
    });
  }

  const client = clientStore.getClient(client_id);
  if (!client) {
    return res.status(401).json({
      error: 'invalid_client',
      error_description: 'Client authentication failed'
    });
  }

  if (!clientStore.validateClient(client_id, client_secret)) {
    return res.status(401).json({
      error: 'invalid_client', 
      error_description: 'Client authentication failed'
    });
  }

  req.oauth = req.oauth || {};
  req.oauth.client = client;
  req.oauth.client_id = client_id;

  next();
}

/**
 * Validate token request parameters
 */
function validateTokenRequest(req, res, next) {
  const { grant_type } = req.body;

  if (!grant_type) {
    return res.status(400).json({
      error: 'invalid_request',
      error_description: 'grant_type is required'
    });
  }

  const supportedGrantTypes = ['authorization_code', 'refresh_token'];
  if (!supportedGrantTypes.includes(grant_type)) {
    return res.status(400).json({
      error: 'unsupported_grant_type',
      error_description: `Supported grant types: ${supportedGrantTypes.join(', ')}`
    });
  }

  // Check if client supports this grant type
  const client = req.oauth?.client;
  if (client && !client.grant_types.includes(grant_type)) {
    return res.status(400).json({
      error: 'unauthorized_client',
      error_description: 'Client is not authorized for this grant_type'
    });
  }

  req.oauth = req.oauth || {};
  req.oauth.grant_type = grant_type;

  next();
}

/**
 * Validate authorization code grant specific parameters
 */
function validateAuthorizationCodeGrant(req, res, next) {
  if (req.oauth.grant_type !== 'authorization_code') {
    return next();
  }

  const { code, redirect_uri, code_verifier } = req.body;

  if (!code) {
    return res.status(400).json({
      error: 'invalid_request',
      error_description: 'code is required for authorization_code grant'
    });
  }

  if (!redirect_uri) {
    return res.status(400).json({
      error: 'invalid_request',
      error_description: 'redirect_uri is required for authorization_code grant'
    });
  }

  req.oauth.code = code;
  req.oauth.redirect_uri = redirect_uri;
  req.oauth.code_verifier = code_verifier;

  next();
}

/**
 * Validate refresh token grant specific parameters
 */
function validateRefreshTokenGrant(req, res, next) {
  if (req.oauth.grant_type !== 'refresh_token') {
    return next();
  }

  const { refresh_token } = req.body;

  if (!refresh_token) {
    return res.status(400).json({
      error: 'invalid_request',
      error_description: 'refresh_token is required for refresh_token grant'
    });
  }

  req.oauth.refresh_token = refresh_token;
  next();
}

/**
 * Validate Bearer token in Authorization header
 */
function validateBearerToken(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    return res.status(401).json({
      error: 'invalid_request',
      error_description: 'Authorization header is required'
    });
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({
      error: 'invalid_request',
      error_description: 'Invalid Authorization header format. Use: Bearer <token>'
    });
  }

  const token = parts[1];
  const tokenData = tokenStore.validateAccessToken(token);
  
  if (!tokenData) {
    return res.status(401).json({
      error: 'invalid_token',
      error_description: 'Invalid or expired access token'
    });
  }

  req.oauth = req.oauth || {};
  req.oauth.token = tokenData;
  req.oauth.access_token = token;

  next();
}

/**
 * Check if scope is authorized for current client/user
 */
function checkScope(requiredScopes) {
  return (req, res, next) => {
    const tokenData = req.oauth?.token;
    
    if (!tokenData) {
      return res.status(401).json({
        error: 'invalid_token',
        error_description: 'No valid token found'
      });
    }

    const tokenScopes = tokenData.scope ? tokenData.scope.split(' ') : [];
    const required = Array.isArray(requiredScopes) ? requiredScopes : [requiredScopes];
    
    const hasAllScopes = required.every(scope => tokenScopes.includes(scope));
    
    if (!hasAllScopes) {
      return res.status(403).json({
        error: 'insufficient_scope',
        error_description: `Required scopes: ${required.join(' ')}`
      });
    }

    next();
  };
}

/**
 * Rate limiting middleware (simple implementation)
 */
function rateLimit(windowMs = 60000, maxRequests = 60) {
  const requests = new Map();
  
  return (req, res, next) => {
    const clientId = req.oauth?.client_id || req.ip;
    const now = Date.now();
    const window = Math.floor(now / windowMs);
    const key = `${clientId}:${window}`;
    
    const currentRequests = requests.get(key) || 0;
    
    if (currentRequests >= maxRequests) {
      return res.status(429).json({
        error: 'too_many_requests',
        error_description: 'Rate limit exceeded'
      });
    }
    
    requests.set(key, currentRequests + 1);
    
    // Cleanup old windows
    for (const [k] of requests) {
      if (k.split(':')[1] < window - 5) {
        requests.delete(k);
      }
    }
    
    next();
  };
}

module.exports = {
  validateAuthorizationRequest,
  validateClientCredentials,
  validateTokenRequest,
  validateAuthorizationCodeGrant,
  validateRefreshTokenGrant,
  validateBearerToken,
  checkScope,
  rateLimit
};