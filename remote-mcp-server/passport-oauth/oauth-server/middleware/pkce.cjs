/**
 * PKCE (Proof Key for Code Exchange) Middleware
 * RFC 7636 implementation for OAuth 2.1 security
 */

const crypto = require('crypto');

/**
 * Validate PKCE parameters in authorization request
 */
function validatePkceChallenge(req, res, next) {
  const { code_challenge, code_challenge_method } = req.query;
  
  // PKCE is required by default
  const pkceRequired = process.env.PKCE_REQUIRED !== 'false';
  
  if (pkceRequired) {
    if (!code_challenge) {
      return res.status(400).json({
        error: 'invalid_request',
        error_description: 'code_challenge parameter is required'
      });
    }

    if (!code_challenge_method) {
      return res.status(400).json({
        error: 'invalid_request', 
        error_description: 'code_challenge_method parameter is required'
      });
    }
  }

  // If PKCE parameters are provided, validate them
  if (code_challenge) {
    // Validate code challenge method
    const supportedMethods = (process.env.SUPPORTED_CODE_CHALLENGE_METHODS || 'S256').split(',');
    if (code_challenge_method && !supportedMethods.includes(code_challenge_method)) {
      return res.status(400).json({
        error: 'invalid_request',
        error_description: `Unsupported code_challenge_method. Supported: ${supportedMethods.join(', ')}`
      });
    }

    // Validate code challenge format (base64url)
    if (!isValidBase64Url(code_challenge)) {
      return res.status(400).json({
        error: 'invalid_request',
        error_description: 'code_challenge must be base64url encoded'
      });
    }

    // Validate code challenge length (43-128 characters for S256)
    if (code_challenge_method === 'S256' && (code_challenge.length < 43 || code_challenge.length > 128)) {
      return res.status(400).json({
        error: 'invalid_request',
        error_description: 'code_challenge length must be between 43 and 128 characters for S256'
      });
    }
  }

  next();
}

/**
 * Validate PKCE code verifier in token request
 */
function validatePkceVerifier(codeVerifier, codeChallenge, codeChallengeMethod) {
  if (!codeVerifier || !codeChallenge || !codeChallengeMethod) {
    return {
      valid: false,
      error: 'invalid_grant',
      error_description: 'PKCE verification failed: missing parameters'
    };
  }

  // Validate code verifier format
  if (!isValidCodeVerifier(codeVerifier)) {
    return {
      valid: false,
      error: 'invalid_grant',
      error_description: 'Invalid code_verifier format'
    };
  }

  // Validate challenge based on method
  let computedChallenge;
  
  switch (codeChallengeMethod) {
    case 'S256':
      computedChallenge = crypto
        .createHash('sha256')
        .update(codeVerifier)
        .digest('base64url');
      break;
    case 'plain':
      computedChallenge = codeVerifier;
      break;
    default:
      return {
        valid: false,
        error: 'invalid_grant',
        error_description: 'Unsupported code_challenge_method'
      };
  }

  if (computedChallenge !== codeChallenge) {
    return {
      valid: false,
      error: 'invalid_grant',
      error_description: 'PKCE verification failed: code_verifier does not match code_challenge'
    };
  }

  return { valid: true };
}

/**
 * Generate PKCE parameters for testing
 */
function generatePkceParameters() {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
    
  return {
    code_verifier: codeVerifier,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256'
  };
}

/**
 * Validate base64url encoding
 */
function isValidBase64Url(str) {
  // Base64url pattern: [A-Za-z0-9_-]+
  return /^[A-Za-z0-9_-]+$/.test(str);
}

/**
 * Validate code verifier format
 * RFC 7636: code verifier must be 43-128 characters, unreserved characters only
 */
function isValidCodeVerifier(codeVerifier) {
  if (!codeVerifier || typeof codeVerifier !== 'string') {
    return false;
  }
  
  // Length check: 43-128 characters
  if (codeVerifier.length < 43 || codeVerifier.length > 128) {
    return false;
  }
  
  // Character check: unreserved characters only (A-Z, a-z, 0-9, -, ., _, ~)
  const unreservedPattern = /^[A-Za-z0-9\-._~]+$/;
  return unreservedPattern.test(codeVerifier);
}

/**
 * Middleware to log PKCE usage for monitoring
 */
function logPkceUsage(req, res, next) {
  const { code_challenge, code_challenge_method } = req.query;
  
  if (code_challenge && code_challenge_method) {
    console.log(`[PKCE] Challenge received: method=${code_challenge_method}, length=${code_challenge.length}`);
  } else {
    console.log('[PKCE] No PKCE challenge provided');
  }
  
  next();
}

module.exports = {
  validatePkceChallenge,
  validatePkceVerifier,
  generatePkceParameters,
  isValidBase64Url,
  isValidCodeVerifier,
  logPkceUsage
};