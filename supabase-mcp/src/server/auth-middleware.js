import { getUserFromToken, createSupabaseClient } from '../utils/supabase.js';
import { authLogger } from '../utils/logger.js';

/**
 * Middleware for Supabase authentication
 */
export class AuthMiddleware {
  constructor() {
    this.supabase = createSupabaseClient();
    authLogger.info('Auth middleware initialized');
  }
  
  /**
   * Validate JWT token and attach user to request
   */
  validate = async (req, res, next) => {
    const startTime = Date.now();
    
    try {
      // Extract token from Authorization header
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        authLogger.warn('Missing Authorization header', { 
          url: req.url, 
          ip: req.ip 
        });
        return this._unauthorized(res, 'Authorization header required');
      }
      
      if (!authHeader.startsWith('Bearer ')) {
        authLogger.warn('Invalid Authorization header format', { 
          url: req.url, 
          ip: req.ip 
        });
        return this._unauthorized(res, 'Bearer token required');
      }
      
      const token = authHeader.replace('Bearer ', '');
      if (!token || token.length < 10) {
        authLogger.warn('Invalid token format', { 
          url: req.url, 
          ip: req.ip,
          tokenLength: token.length
        });
        return this._unauthorized(res, 'Invalid token format');
      }
      
      // Validate token with Supabase
      authLogger.debug('Validating token', { 
        url: req.url, 
        tokenPrefix: token.substring(0, 10) + '...'
      });
      
      const user = await getUserFromToken(token, this.supabase);
      
      // Attach user and token to request
      req.user = user;
      req.token = token;
      req.authDuration = Date.now() - startTime;
      
      authLogger.info('Authentication successful', {
        userId: user.id,
        email: user.email,
        url: req.url,
        duration: `${req.authDuration}ms`
      });
      
      next();
      
    } catch (error) {
      const duration = Date.now() - startTime;
      authLogger.error('Authentication failed', {
        url: req.url,
        ip: req.ip,
        duration: `${duration}ms`,
        error: error.message
      });
      
      return this._unauthorized(res, 'Authentication failed', error.message);
    }
  };
  
  /**
   * Optional authentication - attach user if token is valid but don't fail if missing
   */
  optional = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      // No auth provided, continue without user
      req.user = null;
      return next();
    }
    
    try {
      const token = authHeader.replace('Bearer ', '');
      const user = await getUserFromToken(token, this.supabase);
      
      req.user = user;
      req.token = token;
      
      authLogger.debug('Optional authentication successful', {
        userId: user.id,
        email: user.email,
        url: req.url
      });
      
    } catch (error) {
      authLogger.debug('Optional authentication failed', {
        url: req.url,
        error: error.message
      });
      req.user = null;
    }
    
    next();
  };
  
  /**
   * Check if user has specific role (requires RLS policies in Supabase)
   */
  requireRole = (roles) => {
    return async (req, res, next) => {
      if (!req.user) {
        return this._unauthorized(res, 'Authentication required for role check');
      }
      
      try {
        // In Supabase, roles are typically stored in user metadata or a separate table
        // For this example, we'll check user metadata
        const userRoles = req.user.user_metadata?.roles || req.user.app_metadata?.roles || [];
        
        const hasRequiredRole = Array.isArray(roles) 
          ? roles.some(role => userRoles.includes(role))
          : userRoles.includes(roles);
        
        if (!hasRequiredRole) {
          authLogger.warn('Insufficient permissions', {
            userId: req.user.id,
            userRoles,
            requiredRoles: roles,
            url: req.url
          });
          return this._forbidden(res, 'Insufficient permissions');
        }
        
        authLogger.debug('Role check passed', {
          userId: req.user.id,
          userRoles,
          requiredRoles: roles
        });
        
        next();
        
      } catch (error) {
        authLogger.error('Role check failed', {
          userId: req.user.id,
          error: error.message
        });
        return res.status(500).json({
          error: 'Internal server error during role check'
        });
      }
    };
  };
  
  /**
   * Rate limiting based on user ID
   */
  rateLimit = (requests = 100, windowMs = 60000) => {
    const userRequests = new Map();
    
    return (req, res, next) => {
      if (!req.user) {
        return this._unauthorized(res, 'Authentication required for rate limiting');
      }
      
      const userId = req.user.id;
      const now = Date.now();
      const windowStart = now - windowMs;
      
      // Clean old entries
      if (!userRequests.has(userId)) {
        userRequests.set(userId, []);
      }
      
      const userRequestTimes = userRequests.get(userId);
      const recentRequests = userRequestTimes.filter(time => time > windowStart);
      
      if (recentRequests.length >= requests) {
        authLogger.warn('Rate limit exceeded', {
          userId,
          requests: recentRequests.length,
          limit: requests,
          windowMs
        });
        
        return res.status(429).json({
          error: 'Rate limit exceeded',
          retryAfter: Math.ceil((recentRequests[0] + windowMs - now) / 1000)
        });
      }
      
      // Add current request
      recentRequests.push(now);
      userRequests.set(userId, recentRequests);
      
      next();
    };
  };
  
  /**
   * Send unauthorized response
   */
  _unauthorized(res, message, details = null) {
    const response = {
      error: 'Unauthorized',
      message
    };
    
    if (details && process.env.DEBUG_MODE === 'true') {
      response.details = details;
    }
    
    return res.status(401).json(response);
  }
  
  /**
   * Send forbidden response
   */
  _forbidden(res, message, details = null) {
    const response = {
      error: 'Forbidden',
      message
    };
    
    if (details && process.env.DEBUG_MODE === 'true') {
      response.details = details;
    }
    
    return res.status(403).json(response);
  }
}

/**
 * Create and export middleware instance
 */
export const authMiddleware = new AuthMiddleware();