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

}

/**
 * Create and export middleware instance
 */
export const authMiddleware = new AuthMiddleware();