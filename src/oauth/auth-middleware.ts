import { Request, Response, NextFunction } from 'express';
import { OAuthManager } from './oauth-manager.js';

// Extend Express Request type to include auth
declare global {
  namespace Express {
    interface Request {
      auth?: {
        username: string;
        client_id: string;
        scope: string;
      };
    }
  }
}

/**
 * Create authentication middleware for MCP endpoints
 * 
 * ChatGPT Workaround: Allow unauthenticated tools/list and initialize requests
 * but require auth for actual tool calls
 */
export function createAuthMiddleware(
  oauthManager: OAuthManager | null,
  baseUrl: string,
  requireAuth: boolean
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Skip auth if disabled
    if (!requireAuth || !oauthManager) {
      return next();
    }
    
    // CHATGPT WORKAROUND: Allow unauthenticated discovery requests
    // ChatGPT needs to see tools before authenticating
    const method = req.body?.method;
    if (method === 'initialize' || method === 'tools/list') {
      console.log(`⚠️  Allowing unauthenticated ${method} for ChatGPT compatibility`);
      return next();
    }
    
    const auth = req.headers.authorization;
    
    // Check for Bearer token
    if (!auth || !auth.startsWith('Bearer ')) {
      console.log(`❌ Auth failed: No Bearer token provided for ${method}`);
      return res.status(401)
        .set('WWW-Authenticate', `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`)
        .json({
          jsonrpc: '2.0',
          error: {
            code: -32001,
            message: 'Authorization required',
            data: 'Bearer token must be provided in Authorization header'
          },
          id: null
        });
    }
    
    // Extract token
    const token = auth.substring(7); // Remove "Bearer " prefix
    
    // Validate token
    const validation = oauthManager.validateToken(token);
    
    if (!validation.valid) {
      console.log(`❌ Auth failed: ${validation.error}`);
      return res.status(401).json({
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message: 'Invalid or expired token',
          data: validation.error
        },
        id: null
      });
    }
    
    // Attach user info to request
    req.auth = {
      username: validation.username!,
      client_id: validation.client_id!,
      scope: validation.scope!
    };
    
    // Log authenticated request
    console.log(`✅ Authenticated: ${req.auth.username} (${req.auth.client_id})`);
    
    next();
  };
}
