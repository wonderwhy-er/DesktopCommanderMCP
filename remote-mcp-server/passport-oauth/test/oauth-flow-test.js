#!/usr/bin/env node

/**
 * OAuth 2.1 Flow Test Suite
 * Comprehensive testing of the Passport.js OAuth implementation
 */

// Load environment variables
require('dotenv').config();

const fetch = require('cross-fetch');
const crypto = require('crypto');

// Test configuration
const OAUTH_SERVER = process.env.OAUTH_BASE_URL || 'http://localhost:4449';
const MCP_SERVER = process.env.MCP_BASE_URL || 'http://localhost:3006';

// Colors for output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m'
};

function log(color, message, data = null) {
  console.log(`${colors[color]}${message}${colors.reset}`);
  if (data) {
    console.log(`${colors.cyan}  ${JSON.stringify(data, null, 2)}${colors.reset}`);
  }
}

/**
 * Generate PKCE parameters
 */
function generatePKCE() {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');
  
  return {
    code_verifier: codeVerifier,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state: state
  };
}

/**
 * Test OAuth server health
 */
async function testOAuthServerHealth() {
  log('blue', '🔍 Step 1: Testing OAuth server health...');
  
  try {
    const response = await fetch(`${OAUTH_SERVER}/health`);
    
    if (!response.ok) {
      throw new Error(`Health check failed: ${response.status}`);
    }
    
    const health = await response.json();
    log('green', '✅ OAuth server is healthy', {
      status: health.status,
      version: health.version,
      demo_mode: health.env?.demo_mode
    });
    
    return health;
    
  } catch (error) {
    log('red', `❌ OAuth server health check failed: ${error.message}`);
    throw error;
  }
}

/**
 * Test OAuth metadata endpoint
 */
async function testOAuthMetadata() {
  log('blue', '\\n📋 Step 2: Testing OAuth metadata endpoint...');
  
  try {
    const response = await fetch(`${OAUTH_SERVER}/.well-known/oauth-authorization-server`);
    
    if (!response.ok) {
      throw new Error(`Metadata request failed: ${response.status}`);
    }
    
    const metadata = await response.json();
    
    // Verify required fields
    const requiredFields = [
      'issuer',
      'authorization_endpoint', 
      'token_endpoint',
      'registration_endpoint',
      'introspection_endpoint'
    ];
    
    const missingFields = requiredFields.filter(field => !metadata[field]);
    if (missingFields.length > 0) {
      throw new Error(`Missing required metadata fields: ${missingFields.join(', ')}`);
    }
    
    log('green', '✅ OAuth metadata is valid', {
      issuer: metadata.issuer,
      endpoints: {
        authorization: metadata.authorization_endpoint,
        token: metadata.token_endpoint,
        registration: metadata.registration_endpoint,
        introspection: metadata.introspection_endpoint
      },
      pkce_methods: metadata.code_challenge_methods_supported
    });
    
    return metadata;
    
  } catch (error) {
    log('red', `❌ OAuth metadata test failed: ${error.message}`);
    throw error;
  }
}

/**
 * Test client registration
 */
async function testClientRegistration() {
  log('blue', '\\n📝 Step 3: Testing client registration...');
  
  try {
    const clientRegistration = {
      client_name: 'OAuth Test Client',
      redirect_uris: ['http://localhost:8080/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'openid email profile mcp:tools'
    };
    
    const response = await fetch(`${OAUTH_SERVER}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(clientRegistration)
    });
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Client registration failed: ${response.status} - ${error}`);
    }
    
    const clientInfo = await response.json();
    
    // Verify response
    if (!clientInfo.client_id || !clientInfo.client_secret) {
      throw new Error('Missing client_id or client_secret in registration response');
    }
    
    log('green', '✅ Client registration successful', {
      client_id: clientInfo.client_id,
      client_name: clientInfo.client_name,
      redirect_uris: clientInfo.redirect_uris,
      grant_types: clientInfo.grant_types,
      scope: clientInfo.scope
    });
    
    return clientInfo;
    
  } catch (error) {
    log('red', `❌ Client registration test failed: ${error.message}`);
    throw error;
  }
}

/**
 * Test authorization endpoint
 */
async function testAuthorizationEndpoint(clientInfo, pkceParams) {
  log('blue', '\\n🔐 Step 4: Testing authorization endpoint...');
  
  try {
    const authParams = new URLSearchParams({
      response_type: 'code',
      client_id: clientInfo.client_id,
      redirect_uri: clientInfo.redirect_uris[0],
      scope: clientInfo.scope,
      state: pkceParams.state,
      code_challenge: pkceParams.code_challenge,
      code_challenge_method: pkceParams.code_challenge_method
    });
    
    const authUrl = `${OAUTH_SERVER}/authorize?${authParams.toString()}`;
    
    // In demo mode, this should auto-approve and return a redirect
    const response = await fetch(authUrl, { 
      redirect: 'manual',
      timeout: 10000 
    });
    
    if (response.status === 302) {
      // Auto-approved in demo mode
      const location = response.headers.get('location');
      const redirectUrl = new URL(location);
      const authCode = redirectUrl.searchParams.get('code');
      const returnedState = redirectUrl.searchParams.get('state');
      
      if (!authCode) {
        throw new Error('No authorization code in redirect');
      }
      
      if (returnedState !== pkceParams.state) {
        throw new Error('State parameter mismatch');
      }
      
      log('green', '✅ Authorization endpoint test successful (auto-approved)', {
        code: authCode.substring(0, 10) + '...',
        state: returnedState.substring(0, 10) + '...',
        redirect_uri: redirectUrl.origin + redirectUrl.pathname
      });
      
      return authCode;
      
    } else if (response.status === 200) {
      // Manual approval required
      const html = await response.text();
      
      if (html.includes('Authorization Request') || html.includes('consent')) {
        log('yellow', '⚠️ Authorization requires manual approval (demo mode might be disabled)');
        log('blue', `Authorization URL: ${authUrl}`);
        
        // For testing purposes, we'll skip manual approval
        throw new Error('Manual approval required - enable demo mode for automated testing');
      } else {
        throw new Error('Unexpected response format from authorization endpoint');
      }
    } else {
      throw new Error(`Authorization request failed: ${response.status}`);
    }
    
  } catch (error) {
    log('red', `❌ Authorization endpoint test failed: ${error.message}`);
    throw error;
  }
}

/**
 * Test token exchange
 */
async function testTokenExchange(clientInfo, authCode, pkceParams) {
  log('blue', '\\n🔄 Step 5: Testing token exchange...');
  
  try {
    const tokenRequest = new URLSearchParams({
      grant_type: 'authorization_code',
      code: authCode,
      redirect_uri: clientInfo.redirect_uris[0],
      client_id: clientInfo.client_id,
      client_secret: clientInfo.client_secret,
      code_verifier: pkceParams.code_verifier
    });
    
    const response = await fetch(`${OAUTH_SERVER}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenRequest
    });
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token exchange failed: ${response.status} - ${error}`);
    }
    
    const tokens = await response.json();
    
    // Verify response
    if (!tokens.access_token || !tokens.token_type) {
      throw new Error('Missing access_token or token_type in response');
    }
    
    if (tokens.token_type !== 'Bearer') {
      throw new Error(`Expected Bearer token, got: ${tokens.token_type}`);
    }
    
    log('green', '✅ Token exchange successful', {
      token_type: tokens.token_type,
      expires_in: tokens.expires_in,
      scope: tokens.scope,
      access_token: tokens.access_token.substring(0, 20) + '...',
      refresh_token: tokens.refresh_token ? tokens.refresh_token.substring(0, 20) + '...' : 'None'
    });
    
    return tokens;
    
  } catch (error) {
    log('red', `❌ Token exchange test failed: ${error.message}`);
    throw error;
  }
}

/**
 * Test token introspection
 */
async function testTokenIntrospection(tokens) {
  log('blue', '\\n🔍 Step 6: Testing token introspection...');
  
  try {
    const response = await fetch(`${OAUTH_SERVER}/introspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(tokens.access_token)}`
    });
    
    if (!response.ok) {
      throw new Error(`Token introspection failed: ${response.status}`);
    }
    
    const introspection = await response.json();
    
    if (!introspection.active) {
      throw new Error('Token reported as inactive');
    }
    
    log('green', '✅ Token introspection successful', {
      active: introspection.active,
      scope: introspection.scope,
      client_id: introspection.client_id,
      token_type: introspection.token_type,
      exp: introspection.exp
    });
    
    return introspection;
    
  } catch (error) {
    log('red', `❌ Token introspection test failed: ${error.message}`);
    throw error;
  }
}

/**
 * Test MCP server health
 */
async function testMCPServerHealth() {
  log('blue', '\\n🎯 Step 7: Testing MCP server health...');
  
  try {
    const response = await fetch(`${MCP_SERVER}/health`);
    
    if (!response.ok) {
      throw new Error(`MCP health check failed: ${response.status}`);
    }
    
    const health = await response.json();
    
    log('green', '✅ MCP server is healthy', {
      service: health.service,
      version: health.version,
      oauth_required: health.oauth_required
    });
    
    return health;
    
  } catch (error) {
    log('red', `❌ MCP server health check failed: ${error.message}`);
    throw error;
  }
}

/**
 * Test MCP server with OAuth token
 */
async function testMCPWithToken(tokens) {
  log('blue', '\\n📡 Step 8: Testing MCP server with OAuth token...');
  
  try {
    // Test tools endpoint
    const toolsResponse = await fetch(`${MCP_SERVER}/tools`, {
      headers: { 'Authorization': `Bearer ${tokens.access_token}` }
    });
    
    if (!toolsResponse.ok) {
      throw new Error(`MCP tools request failed: ${toolsResponse.status}`);
    }
    
    const tools = await toolsResponse.json();
    
    log('green', '✅ MCP tools endpoint accessible', {
      tools_count: tools.tools?.length || 0,
      sample_tools: tools.tools?.slice(0, 3).map(t => t.name) || []
    });
    
    // Test message endpoint with echo tool
    const echoRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'echo',
        arguments: { text: 'OAuth test message' }
      }
    };
    
    const messageResponse = await fetch(`${MCP_SERVER}/message`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(echoRequest)
    });
    
    if (!messageResponse.ok) {
      throw new Error(`MCP message request failed: ${messageResponse.status}`);
    }
    
    const messageResult = await messageResponse.json();
    
    log('green', '✅ MCP message endpoint working', {
      jsonrpc: messageResult.jsonrpc,
      id: messageResult.id,
      has_result: !!messageResult.result
    });
    
    return { tools, messageResult };
    
  } catch (error) {
    log('red', `❌ MCP server with token test failed: ${error.message}`);
    throw error;
  }
}

/**
 * Test refresh token flow
 */
async function testRefreshToken(clientInfo, tokens) {
  if (!tokens.refresh_token) {
    log('yellow', '\\n⚠️ Step 9: Skipping refresh token test (no refresh token provided)');
    return null;
  }
  
  log('blue', '\\n🔄 Step 9: Testing refresh token flow...');
  
  try {
    const refreshRequest = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: clientInfo.client_id,
      client_secret: clientInfo.client_secret
    });
    
    const response = await fetch(`${OAUTH_SERVER}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: refreshRequest
    });
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Refresh token failed: ${response.status} - ${error}`);
    }
    
    const newTokens = await response.json();
    
    log('green', '✅ Refresh token flow successful', {
      token_type: newTokens.token_type,
      expires_in: newTokens.expires_in,
      new_access_token: newTokens.access_token.substring(0, 20) + '...',
      new_refresh_token: newTokens.refresh_token ? 'Provided' : 'Not provided'
    });
    
    return newTokens;
    
  } catch (error) {
    log('red', `❌ Refresh token test failed: ${error.message}`);
    throw error;
  }
}

/**
 * Run complete OAuth flow test
 */
async function runCompleteTest() {
  try {
    log('magenta', '🚀 Starting Complete OAuth 2.1 Flow Test');
    log('magenta', '============================================\\n');
    
    // Test OAuth server
    await testOAuthServerHealth();
    const metadata = await testOAuthMetadata();
    const clientInfo = await testClientRegistration();
    
    // Generate PKCE parameters
    const pkceParams = generatePKCE();
    log('blue', '\\n🔐 PKCE parameters generated', {
      code_challenge_method: pkceParams.code_challenge_method,
      code_challenge: pkceParams.code_challenge.substring(0, 20) + '...'
    });
    
    // Test authorization flow
    const authCode = await testAuthorizationEndpoint(clientInfo, pkceParams);
    const tokens = await testTokenExchange(clientInfo, authCode, pkceParams);
    const introspection = await testTokenIntrospection(tokens);
    
    // Test MCP server
    await testMCPServerHealth();
    await testMCPWithToken(tokens);
    
    // Test refresh token (if available)
    await testRefreshToken(clientInfo, tokens);
    
    // Success summary
    log('green', '\\n🎉 ALL TESTS PASSED!');
    log('green', '===================');
    log('blue', '✅ OAuth 2.1 server is fully functional');
    log('blue', '✅ PKCE implementation working correctly');
    log('blue', '✅ Client registration working');
    log('blue', '✅ Authorization flow working');
    log('blue', '✅ Token exchange working');
    log('blue', '✅ Token introspection working');
    log('blue', '✅ MCP server integration working');
    log('blue', '✅ Bearer token authentication working');
    
    return {
      success: true,
      clientInfo,
      tokens,
      introspection,
      metadata
    };
    
  } catch (error) {
    log('red', `\\n💥 TEST FAILED: ${error.message}`);
    log('red', '===============');
    
    // Diagnosis
    log('yellow', '\\n🔧 Troubleshooting Tips:');
    log('yellow', '1. Ensure OAuth server is running: npm run start');
    log('yellow', '2. Ensure MCP server is running: npm run mcp');
    log('yellow', '3. Check DEMO_MODE=true in .env file');
    log('yellow', '4. Verify server URLs in .env configuration');
    log('yellow', '5. Check server logs for detailed error messages');
    
    return {
      success: false,
      error: error.message
    };
  }
}

// Run tests if called directly
if (require.main === module) {
  console.log(`Testing OAuth Server: ${OAUTH_SERVER}`);
  console.log(`Testing MCP Server: ${MCP_SERVER}\\n`);
  
  runCompleteTest().then(result => {
    process.exit(result.success ? 0 : 1);
  }).catch(error => {
    console.error('Unexpected error:', error);
    process.exit(1);
  });
}

module.exports = {
  runCompleteTest,
  testOAuthServerHealth,
  testOAuthMetadata,
  testClientRegistration,
  testTokenExchange,
  testTokenIntrospection,
  testMCPServerHealth,
  testMCPWithToken,
  generatePKCE
};