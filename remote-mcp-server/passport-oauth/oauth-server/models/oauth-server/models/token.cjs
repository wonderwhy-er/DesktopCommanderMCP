/**
 * Token Model
 * In-memory storage for OAuth tokens, authorization codes, and PKCE data
 */

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

class TokenStore {
  constructor() {
    this.authorizationCodes = new Map();
    this.accessTokens = new Map();
    this.refreshTokens = new Map();
    this.pkceData = new Map();
    
    // Cleanup expired tokens every 5 minutes
    setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  /**
   * Generate authorization code
   */
  generateAuthorizationCode(client_id, user_id, redirect_uri, scope, codeChallenge, codeChallengeMethod) {
    const code = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + (parseInt(process.env.AUTHORIZATION_CODE_EXPIRY) || 600) * 1000;
    
    const authData = {
      code,
      client_id,
      user_id,
      redirect_uri,
      scope,
      created_at: Date.now(),
      expires_at: expiresAt,
      used: false
    };

    // Store PKCE data if provided
    if (codeChallenge && codeChallengeMethod) {
      this.pkceData.set(code, {
        code_challenge: codeChallenge,
        code_challenge_method: codeChallengeMethod
      });
    }

    this.authorizationCodes.set(code, authData);
    return code;
  }

  /**
   * Validate and consume authorization code
   */
  validateAuthorizationCode(code, client_id, redirect_uri, codeVerifier = null) {
    const authData = this.authorizationCodes.get(code);
    
    if (!authData) {
      throw new Error('Invalid authorization code');
    }

    if (authData.used) {
      throw new Error('Authorization code already used');
    }

    if (Date.now() > authData.expires_at) {
      this.authorizationCodes.delete(code);
      throw new Error('Authorization code expired');
    }

    if (authData.client_id !== client_id) {
      throw new Error('Client ID mismatch');
    }

    if (authData.redirect_uri !== redirect_uri) {
      throw new Error('Redirect URI mismatch');
    }

    // Validate PKCE if present
    const pkceData = this.pkceData.get(code);
    if (pkceData) {
      if (!codeVerifier) {
        throw new Error('Code verifier required for PKCE');
      }

      const challenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
      if (challenge !== pkceData.code_challenge) {
        throw new Error('Invalid code verifier');
      }
      
      // Cleanup PKCE data
      this.pkceData.delete(code);
    }

    // Mark as used
    authData.used = true;
    this.authorizationCodes.set(code, authData);

    return authData;
  }

  /**
   * Generate access token (JWT)
   */
  generateAccessToken(client_id, user_id, scope) {
    const jti = uuidv4();
    const now = Math.floor(Date.now() / 1000);
    const expiresIn = parseInt(process.env.ACCESS_TOKEN_EXPIRY) || 3600;
    
    const payload = {
      iss: process.env.OAUTH_BASE_URL || 'http://localhost:4449',
      sub: user_id,
      aud: client_id,
      exp: now + expiresIn,
      iat: now,
      jti: jti,
      scope: scope,
      token_type: 'access_token'
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET);
    
    // Store token metadata
    this.accessTokens.set(jti, {
      jti,
      client_id,
      user_id,
      scope,
      created_at: now * 1000,
      expires_at: (now + expiresIn) * 1000,
      active: true
    });

    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: expiresIn,
      scope: scope,
      jti: jti
    };
  }

  /**
   * Generate refresh token
   */
  generateRefreshToken(client_id, user_id, scope) {
    const refreshToken = crypto.randomBytes(32).toString('hex');
    const expiresIn = parseInt(process.env.REFRESH_TOKEN_EXPIRY) || 86400;
    const expiresAt = Date.now() + (expiresIn * 1000);
    
    this.refreshTokens.set(refreshToken, {
      client_id,
      user_id,
      scope,
      created_at: Date.now(),
      expires_at: expiresAt,
      active: true
    });

    return {
      refresh_token: refreshToken,
      expires_in: expiresIn
    };
  }

  /**
   * Validate access token
   */
  validateAccessToken(token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const tokenData = this.accessTokens.get(decoded.jti);
      
      if (!tokenData || !tokenData.active) {
        return null;
      }

      if (Date.now() > tokenData.expires_at) {
        this.revokeAccessToken(decoded.jti);
        return null;
      }

      return {
        ...decoded,
        active: true,
        client_id: tokenData.client_id,
        username: decoded.sub
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Introspect token (RFC 7662)
   */
  introspectToken(token) {
    const tokenData = this.validateAccessToken(token);
    
    if (!tokenData) {
      return { active: false };
    }

    return {
      active: true,
      scope: tokenData.scope,
      client_id: tokenData.client_id,
      username: tokenData.username || tokenData.sub,
      token_type: 'Bearer',
      exp: tokenData.exp,
      iat: tokenData.iat,
      sub: tokenData.sub,
      aud: tokenData.aud,
      iss: tokenData.iss,
      jti: tokenData.jti
    };
  }

  /**
   * Refresh access token
   */
  refreshAccessToken(refreshToken, client_id) {
    const refreshData = this.refreshTokens.get(refreshToken);
    
    if (!refreshData) {
      throw new Error('Invalid refresh token');
    }

    if (!refreshData.active) {
      throw new Error('Refresh token revoked');
    }

    if (Date.now() > refreshData.expires_at) {
      this.refreshTokens.delete(refreshToken);
      throw new Error('Refresh token expired');
    }

    if (refreshData.client_id !== client_id) {
      throw new Error('Client ID mismatch');
    }

    // Generate new access token
    const accessTokenData = this.generateAccessToken(
      refreshData.client_id,
      refreshData.user_id,
      refreshData.scope
    );

    // Check if refresh token rotation is enabled (default: disabled for compatibility)
    const enableTokenRotation = process.env.ENABLE_REFRESH_TOKEN_ROTATION === 'true';
    
    if (enableTokenRotation) {
      // Generate new refresh token (token rotation)
      const newRefreshTokenData = this.generateRefreshToken(
        refreshData.client_id,
        refreshData.user_id,
        refreshData.scope
      );

      // Revoke old refresh token
      this.refreshTokens.delete(refreshToken);
      
      console.log('[Token Store] Refresh token rotated for security');

      return {
        ...accessTokenData,
        ...newRefreshTokenData
      };
    } else {
      // Keep the same refresh token (better compatibility with MCP clients)
      console.log('[Token Store] Refresh token reused (rotation disabled)');
      
      return {
        ...accessTokenData,
        refresh_token: refreshToken
      };
    }
  }

  /**
   * Revoke access token
   */
  revokeAccessToken(jti) {
    const tokenData = this.accessTokens.get(jti);
    if (tokenData) {
      tokenData.active = false;
      this.accessTokens.set(jti, tokenData);
    }
  }

  /**
   * Revoke refresh token
   */
  revokeRefreshToken(refreshToken) {
    const refreshData = this.refreshTokens.get(refreshToken);
    if (refreshData) {
      refreshData.active = false;
      this.refreshTokens.set(refreshToken, refreshData);
    }
  }

  /**
   * Cleanup expired tokens
   */
  cleanup() {
    const now = Date.now();
    
    // Cleanup authorization codes
    for (const [code, data] of this.authorizationCodes.entries()) {
      if (now > data.expires_at) {
        this.authorizationCodes.delete(code);
        this.pkceData.delete(code);
      }
    }

    // Cleanup access tokens
    for (const [jti, data] of this.accessTokens.entries()) {
      if (now > data.expires_at) {
        this.accessTokens.delete(jti);
      }
    }

    // Cleanup refresh tokens
    for (const [token, data] of this.refreshTokens.entries()) {
      if (now > data.expires_at) {
        this.refreshTokens.delete(token);
      }
    }
  }

  /**
   * Get token statistics (for monitoring)
   */
  getStats() {
    return {
      active_authorization_codes: this.authorizationCodes.size,
      active_access_tokens: this.accessTokens.size,
      active_refresh_tokens: this.refreshTokens.size,
      active_pkce_challenges: this.pkceData.size
    };
  }
}

// Export singleton instance
module.exports = new TokenStore();