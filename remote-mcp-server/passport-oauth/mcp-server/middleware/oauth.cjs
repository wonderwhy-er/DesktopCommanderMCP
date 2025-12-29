/**
 * OAuth Bearer Token Validation Middleware for MCP Server
 */

const fetch = require('cross-fetch');

/**
 * Helper function to send error response (SSE-aware)
 */
function sendErrorResponse(req, res, statusCode, error, description) {
  // Check if this is an SSE request (based on Accept header or path)
  const acceptsSSE = req.headers.accept && req.headers.accept.includes('text/event-stream');
  const isSSEEndpoint = req.path === '/sse';
  
  if (acceptsSSE || isSSEEndpoint) {
    // Send SSE error format
    res.writeHead(statusCode, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    
    res.write('event: error\n');
    res.write(`data: ${JSON.stringify({ error, error_description: description })}\n\n`);
    res.end();
  } else {
    // Send regular JSON error
    res.status(statusCode).json({
      error,
      error_description: description
    });
  }
}

/**
 * Validate Bearer token via OAuth introspection
 */
function validateBearerToken(introspectionUrl) {
  return async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;
      
      if (!authHeader) {
        console.log('[MCP OAuth] No authorization header found');
        
        // Add WWW-Authenticate header pointing to the correct authorization endpoint
        const realm = `https://${req.get('host')}`;
        const authorizationUri = `https://${req.get('host')}/authorize`;
        
        res.set('WWW-Authenticate', 
          `Bearer realm="${realm}", authorization_uri="${authorizationUri}", ` +
          `error="invalid_request", error_description="The request is missing a required Authorization header"`
        );
        
        return sendErrorResponse(req, res, 401, 'unauthorized', 'Authorization header required');
      }

      const parts = authHeader.split(' ');
      if (parts.length !== 2 || parts[0] !== 'Bearer') {
        console.log('[MCP OAuth] Invalid authorization header format');
        return sendErrorResponse(req, res, 401, 'unauthorized', 'Invalid Authorization header format. Use: Bearer <token>');
      }

      const token = parts[1];
      console.log(`[MCP OAuth] Validating token: ${token.substring(0, 10)}...`);
      
      // Introspect token with OAuth server
      const introspectionResponse = await fetch(introspectionUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: `token=${encodeURIComponent(token)}`
      });

      if (!introspectionResponse.ok) {
        console.error('[MCP OAuth] Token introspection failed:', introspectionResponse.status);
        console.error('[MCP OAuth] Introspection URL:', introspectionUrl);
        return sendErrorResponse(req, res, 401, 'unauthorized', 'Token validation failed');
      }

      const introspectionResult = await introspectionResponse.json();
      console.log('[MCP OAuth] Introspection result:', introspectionResult);
      
      if (!introspectionResult.active) {
        console.log('[MCP OAuth] Token is not active');
        return sendErrorResponse(req, res, 401, 'unauthorized', 'Token is not active');
      }

      // Attach token data to request
      req.oauth = {
        token: introspectionResult,
        access_token: token,
        client_id: introspectionResult.client_id,
        user_id: introspectionResult.sub,
        scope: introspectionResult.scope
      };

      console.log(`[MCP OAuth] ✅ Token validated for client: ${introspectionResult.client_id}, user: ${introspectionResult.sub}`);
      next();

    } catch (error) {
      console.error('[MCP OAuth] Token validation error:', error);
      console.error('[MCP OAuth] Error details:', error.message);
      return sendErrorResponse(req, res, 500, 'server_error', 'Token validation failed');
    }
  };
}

/**
 * Check if request has required OAuth scope
 */
function requireScope(requiredScopes) {
  return (req, res, next) => {
    const tokenData = req.oauth?.token;
    
    if (!tokenData) {
      console.log('[MCP OAuth] No valid token found in scope check');
      return sendErrorResponse(req, res, 401, 'unauthorized', 'No valid token found');
    }

    const tokenScopes = tokenData.scope ? tokenData.scope.split(' ') : [];
    const required = Array.isArray(requiredScopes) ? requiredScopes : [requiredScopes];
    
    const hasAllScopes = required.every(scope => tokenScopes.includes(scope));
    
    if (!hasAllScopes) {
      console.log(`[MCP OAuth] Insufficient scope. Required: ${required.join(' ')}, Available: ${tokenScopes.join(' ')}`);
      return sendErrorResponse(req, res, 403, 'insufficient_scope', 
        `Required scopes: ${required.join(' ')}, Current scopes: ${tokenScopes.join(' ')}`);
    }

    console.log(`[MCP OAuth] ✅ Scope check passed: ${required.join(' ')}`);
    next();
  };
}

/**
 * Cache for token validation results
 */
class TokenCache {
  constructor(ttlMs = 60000) { // 1 minute default TTL
    this.cache = new Map();
    this.ttl = ttlMs;
    
    // Cleanup expired entries every 5 minutes
    setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  get(token) {
    const entry = this.cache.get(token);
    if (!entry) return null;
    
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(token);
      return null;
    }
    
    return entry.data;
  }

  set(token, data) {
    this.cache.set(token, {
      data,
      expiresAt: Date.now() + this.ttl
    });
  }

  cleanup() {
    const now = Date.now();
    for (const [token, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(token);
      }
    }
  }

  getStats() {
    return {
      size: this.cache.size,
      ttl_ms: this.ttl
    };
  }
}

/**
 * Create cached token validator
 */
function createCachedTokenValidator(introspectionUrl, cacheTtl = 60000) {
  const tokenCache = new TokenCache(cacheTtl);
  
  return async (req, res, next) => {
    try {
      const authHeader = req.headers.authorization;
      
      if (!authHeader) {
        // Set WWW-Authenticate header as required by OAuth 2.0 RFC 6749
        const oauthServerUrl = process.env.OAUTH_BASE_URL || 'http://localhost:4449';
        res.set('WWW-Authenticate', `Bearer realm="${req.headers.host || 'localhost'}", authorization_uri="${oauthServerUrl}/authorize", error="invalid_request", error_description="The request is missing a required Authorization header"`);
        
        console.log('[MCP OAuth Cache] No authorization header found');
        return sendErrorResponse(req, res, 401, 'unauthorized', 'Authorization header required');
      }

      const parts = authHeader.split(' ');
      if (parts.length !== 2 || parts[0] !== 'Bearer') {
        // Set WWW-Authenticate header for invalid Bearer token format
        const oauthServerUrl = process.env.OAUTH_BASE_URL || 'http://localhost:4449';
        res.set('WWW-Authenticate', `Bearer realm="${req.headers.host || 'localhost'}", authorization_uri="${oauthServerUrl}/authorize", error="invalid_token", error_description="Invalid Authorization header format. Use: Bearer <token>"`);
        
        console.log('[MCP OAuth Cache] Invalid authorization header format');
        return sendErrorResponse(req, res, 401, 'unauthorized', 'Invalid Authorization header format');
      }

      const token = parts[1];
      
      // Check cache first
      let introspectionResult = tokenCache.get(token);
      
      if (!introspectionResult) {
        // Introspect with OAuth server
        const introspectionResponse = await fetch(introspectionUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: `token=${encodeURIComponent(token)}`
        });

        if (!introspectionResponse.ok) {
          console.error('[MCP OAuth Cache] Token introspection failed:', introspectionResponse.status);
          console.error('[MCP OAuth Cache] Introspection URL:', introspectionUrl);
          // Set WWW-Authenticate header for token validation failure
          const oauthServerUrl = process.env.OAUTH_BASE_URL || 'http://localhost:4449';
          res.set('WWW-Authenticate', `Bearer realm="${req.headers.host || 'localhost'}", authorization_uri="${oauthServerUrl}/authorize", error="invalid_token", error_description="Token validation failed"`);
          
          return sendErrorResponse(req, res, 401, 'unauthorized', 'Token validation failed');
        }

        introspectionResult = await introspectionResponse.json();
        
        // Cache the result if token is active
        if (introspectionResult.active) {
          tokenCache.set(token, introspectionResult);
        }
      }
      
      if (!introspectionResult.active) {
        // Set WWW-Authenticate header for inactive token
        const oauthServerUrl = process.env.OAUTH_BASE_URL || 'http://localhost:4449';
        res.set('WWW-Authenticate', `Bearer realm="${req.headers.host || 'localhost'}", authorization_uri="${oauthServerUrl}/authorize", error="invalid_token", error_description="Token is not active"`);
        
        console.log('[MCP OAuth Cache] Token is not active');
        return sendErrorResponse(req, res, 401, 'unauthorized', 'Token is not active');
      }

      // Attach token data to request
      req.oauth = {
        token: introspectionResult,
        access_token: token,
        client_id: introspectionResult.client_id,
        user_id: introspectionResult.sub,
        scope: introspectionResult.scope,
        cached: tokenCache.get(token) !== null
      };

      next();

    } catch (error) {
      console.error('[MCP OAuth Cache] Token validation error:', error);
      console.error('[MCP OAuth Cache] Error details:', error.message);
      return sendErrorResponse(req, res, 500, 'server_error', 'Token validation failed');
    }
  };
}

module.exports = {
  validateBearerToken,
  requireScope,
  createCachedTokenValidator,
  TokenCache
};