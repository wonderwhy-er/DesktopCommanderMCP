/**
 * OAuth Token Introspection
 * RFC 7662 implementation
 */

const express = require('express');
const router = express.Router();
const tokenStore = require('../models/oauth-server/models/token.cjs');
const clientStore = require('../models/oauth-server/models/client.cjs');
const { rateLimit } = require('../middleware/auth.cjs');

/**
 * Token Introspection Endpoint
 * POST /introspect
 */
router.post('/introspect',
  rateLimit(60000, 200), // 200 requests per minute
  validateIntrospectionRequest,
  async (req, res) => {
    try {
      const { token, token_type_hint } = req.body;
      
      console.log(`[OAuth] Token introspection request for token: ${token.substring(0, 20)}...`);

      // Introspect the token
      const introspectionResult = tokenStore.introspectToken(token);
      
      // Add additional metadata if token is active
      if (introspectionResult.active) {
        // Get client information
        const client = clientStore.getClient(introspectionResult.client_id);
        if (client) {
          introspectionResult.client_name = client.client_name;
        }

        // Add token type hint if provided and matches
        if (token_type_hint) {
          introspectionResult.token_type_hint = token_type_hint;
        }

        console.log(`[OAuth] Token introspection successful for client: ${introspectionResult.client_id}`);
      } else {
        console.log(`[OAuth] Token introspection failed - token inactive`);
      }

      res.json(introspectionResult);

    } catch (error) {
      console.error('[OAuth] Token introspection error:', error);
      
      // RFC 7662 specifies that errors should return inactive token response
      res.json({ active: false });
    }
  }
);

/**
 * Validate introspection request
 */
function validateIntrospectionRequest(req, res, next) {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({
      error: 'invalid_request',
      error_description: 'token parameter is required'
    });
  }

  // In a production environment, you would typically require client authentication
  // for the introspection endpoint. For demo purposes, we'll allow it without auth.
  if (process.env.DEMO_MODE !== 'true') {
    // Validate client credentials for production
    const authHeader = req.headers.authorization;
    const { client_id, client_secret } = req.body;

    let clientAuth = false;

    // Check Basic auth
    if (authHeader && authHeader.startsWith('Basic ')) {
      const credentials = Buffer.from(authHeader.slice(6), 'base64').toString('ascii');
      const [basicClientId, basicClientSecret] = credentials.split(':');
      clientAuth = clientStore.validateClient(basicClientId, basicClientSecret);
    }
    // Check POST body auth
    else if (client_id && client_secret) {
      clientAuth = clientStore.validateClient(client_id, client_secret);
    }

    if (!clientAuth) {
      return res.status(401).json({
        error: 'invalid_client',
        error_description: 'Client authentication required for token introspection'
      });
    }
  }

  next();
}

/**
 * Batch Token Introspection (Non-standard extension)
 * POST /introspect/batch
 */
router.post('/introspect/batch',
  rateLimit(60000, 50), // 50 batch requests per minute
  validateBatchIntrospectionRequest,
  async (req, res) => {
    try {
      const { tokens } = req.body;
      
      console.log(`[OAuth] Batch token introspection request for ${tokens.length} tokens`);

      const results = tokens.map(tokenRequest => {
        try {
          const { token, token_type_hint } = tokenRequest;
          const result = tokenStore.introspectToken(token);
          
          if (result.active && token_type_hint) {
            result.token_type_hint = token_type_hint;
          }
          
          return {
            token: token.substring(0, 20) + '...', // Partial token for identification
            ...result
          };
        } catch (error) {
          return {
            token: tokenRequest.token?.substring(0, 20) + '...',
            active: false,
            error: 'introspection_failed'
          };
        }
      });

      res.json({ results });

    } catch (error) {
      console.error('[OAuth] Batch token introspection error:', error);
      res.status(500).json({
        error: 'server_error',
        error_description: 'Batch introspection failed'
      });
    }
  }
);

/**
 * Validate batch introspection request
 */
function validateBatchIntrospectionRequest(req, res, next) {
  const { tokens } = req.body;

  if (!tokens || !Array.isArray(tokens) || tokens.length === 0) {
    return res.status(400).json({
      error: 'invalid_request',
      error_description: 'tokens parameter must be a non-empty array'
    });
  }

  if (tokens.length > 100) {
    return res.status(400).json({
      error: 'invalid_request',
      error_description: 'Maximum 100 tokens per batch request'
    });
  }

  // Validate each token request
  for (const tokenRequest of tokens) {
    if (!tokenRequest.token) {
      return res.status(400).json({
        error: 'invalid_request',
        error_description: 'Each token request must include a token field'
      });
    }
  }

  next();
}

/**
 * Token Revocation Endpoint (RFC 7009)
 * POST /revoke
 */
router.post('/revoke',
  rateLimit(60000, 100), // 100 revocations per minute
  validateRevocationRequest,
  async (req, res) => {
    try {
      const { token, token_type_hint } = req.body;
      
      console.log(`[OAuth] Token revocation request for token: ${token.substring(0, 20)}...`);

      // Try to revoke as access token first
      if (token_type_hint === 'refresh_token') {
        tokenStore.revokeRefreshToken(token);
      } else {
        // Try to decode as access token to get JTI
        try {
          const jwt = require('jsonwebtoken');
          const decoded = jwt.decode(token);
          if (decoded && decoded.jti) {
            tokenStore.revokeAccessToken(decoded.jti);
          } else {
            // Try as refresh token
            tokenStore.revokeRefreshToken(token);
          }
        } catch (error) {
          // Try as refresh token
          tokenStore.revokeRefreshToken(token);
        }
      }

      console.log(`[OAuth] Token revocation completed`);
      
      // RFC 7009 specifies that revocation endpoint should return 200 OK
      // regardless of whether the token was found or not
      res.status(200).json({ revoked: true });

    } catch (error) {
      console.error('[OAuth] Token revocation error:', error);
      
      // Still return 200 OK as per RFC 7009
      res.status(200).json({ revoked: true });
    }
  }
);

/**
 * Validate revocation request
 */
function validateRevocationRequest(req, res, next) {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({
      error: 'invalid_request',
      error_description: 'token parameter is required'
    });
  }

  // In production, require client authentication
  if (process.env.DEMO_MODE !== 'true') {
    const authHeader = req.headers.authorization;
    const { client_id, client_secret } = req.body;

    let clientAuth = false;

    if (authHeader && authHeader.startsWith('Basic ')) {
      const credentials = Buffer.from(authHeader.slice(6), 'base64').toString('ascii');
      const [basicClientId, basicClientSecret] = credentials.split(':');
      clientAuth = clientStore.validateClient(basicClientId, basicClientSecret);
    } else if (client_id && client_secret) {
      clientAuth = clientStore.validateClient(client_id, client_secret);
    }

    if (!clientAuth) {
      return res.status(401).json({
        error: 'invalid_client',
        error_description: 'Client authentication required for token revocation'
      });
    }
  }

  next();
}

/**
 * Token Information Endpoint (Non-standard extension)
 * GET /token/info
 */
router.get('/token/info',
  rateLimit(60000, 100),
  (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
          error: 'invalid_request',
          error_description: 'Bearer token required'
        });
      }

      const token = authHeader.slice(7);
      const tokenData = tokenStore.validateAccessToken(token);
      
      if (!tokenData) {
        return res.status(401).json({
          error: 'invalid_token',
          error_description: 'Invalid or expired token'
        });
      }

      // Return safe token information
      res.json({
        active: true,
        scope: tokenData.scope,
        client_id: tokenData.client_id,
        username: tokenData.username,
        exp: tokenData.exp,
        iat: tokenData.iat,
        sub: tokenData.sub
      });

    } catch (error) {
      console.error('[OAuth] Token info error:', error);
      res.status(500).json({
        error: 'server_error',
        error_description: 'Internal server error'
      });
    }
  }
);

module.exports = router;