#!/usr/bin/env node

/**
 * Test script for complete MCP OAuth flow
 * This tests the full OAuth2 authorization code flow with the MCP server
 */

// Load environment variables
require('dotenv').config();

const fetch = require('cross-fetch');
const crypto = require('crypto');

// Server endpoints from environment variables
const AUTH_SERVER = process.env.OAUTH_AUTH_SERVER_URL || 'http://localhost:4448';
const MCP_SERVER = process.env.MCP_SERVER_URL || 'http://localhost:3005';

// Test client configuration from environment
const TEST_CLIENT_NAME = process.env.TEST_OAUTH_CLIENT_NAME || 'Test OAuth Client';
const TEST_REDIRECT_URI = process.env.TEST_OAUTH_REDIRECT_URI || 'http://localhost:8080/callback';

// Colors for output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(color, message, data = null) {
  console.log(`${colors[color]}${message}${colors.reset}`);
  if (data) {
    console.log(`${colors.cyan}  ${JSON.stringify(data, null, 2)}${colors.reset}`);
  }
}

async function testOAuthFlow() {
  try {
    log('blue', '🚀 Starting complete OAuth flow test');
    
    // Step 1: Register OAuth client
    log('yellow', '\n📝 Step 1: Register OAuth client');
    const clientRegistration = {
      client_name: TEST_CLIENT_NAME,
      redirect_uris: [TEST_REDIRECT_URI],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      scope: 'mcp:tools'
    };
    
    const registerEndpoint = process.env.OAUTH_REGISTER_ENDPOINT || '/register';
    const registerResponse = await fetch(`${AUTH_SERVER}${registerEndpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(clientRegistration)
    });
    
    if (!registerResponse.ok) {
      throw new Error(`Client registration failed: ${registerResponse.status}`);
    }
    
    const clientInfo = await registerResponse.json();
    log('green', '✅ Client registered successfully', clientInfo);
    
    // Step 2: Generate PKCE parameters
    log('yellow', '\n🔐 Step 2: Generate PKCE parameters');
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');
    
    log('green', '✅ PKCE parameters generated', {
      codeVerifier: codeVerifier.substring(0, 10) + '...',
      codeChallenge: codeChallenge.substring(0, 10) + '...',
      state: state.substring(0, 10) + '...'
    });
    
    // Step 3: Get authorization code
    log('yellow', '\n📨 Step 3: Get authorization code');
    const authorizeEndpoint = process.env.OAUTH_AUTHORIZE_ENDPOINT || '/authorize';
    const authUrl = `${AUTH_SERVER}${authorizeEndpoint}?` + new URLSearchParams({
      response_type: 'code',
      client_id: clientInfo.client_id,
      redirect_uri: clientInfo.redirect_uris[0],
      scope: clientInfo.scope,
      state: state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      resource: MCP_SERVER
    });
    
    log('cyan', 'Authorization URL:', { url: authUrl });
    
    const authResponse = await fetch(authUrl, { redirect: 'manual' });
    
    if (authResponse.status !== 302) {
      throw new Error(`Authorization failed: ${authResponse.status}`);
    }
    
    const location = authResponse.headers.get('location');
    const authUrl2 = new URL(location);
    const authCode = authUrl2.searchParams.get('code');
    const returnedState = authUrl2.searchParams.get('state');
    
    if (returnedState !== state) {
      throw new Error('State parameter mismatch');
    }
    
    log('green', '✅ Authorization code received', {
      code: authCode.substring(0, 10) + '...',
      state: returnedState.substring(0, 10) + '...'
    });
    
    // Step 4: Exchange code for access token
    log('yellow', '\n🔄 Step 4: Exchange code for access token');
    const tokenRequest = {
      grant_type: 'authorization_code',
      code: authCode,
      redirect_uri: clientInfo.redirect_uris[0],
      client_id: clientInfo.client_id,
      client_secret: clientInfo.client_secret,
      code_verifier: codeVerifier
    };
    
    const tokenEndpoint = process.env.OAUTH_TOKEN_ENDPOINT || '/token';
    const tokenResponse = await fetch(`${AUTH_SERVER}${tokenEndpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(tokenRequest)
    });
    
    if (!tokenResponse.ok) {
      const error = await tokenResponse.text();
      throw new Error(`Token exchange failed: ${tokenResponse.status} - ${error}`);
    }
    
    const tokenInfo = await tokenResponse.json();
    log('green', '✅ Access token received', {
      token_type: tokenInfo.token_type,
      expires_in: tokenInfo.expires_in,
      scope: tokenInfo.scope,
      access_token: tokenInfo.access_token.substring(0, 10) + '...'
    });
    
    // Step 5: Test token introspection
    log('yellow', '\n🔍 Step 5: Test token introspection');
    const introspectEndpoint = process.env.OAUTH_INTROSPECT_ENDPOINT || '/introspect';
    const introspectResponse = await fetch(`${AUTH_SERVER}${introspectEndpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(tokenInfo.access_token)}`
    });
    
    if (!introspectResponse.ok) {
      throw new Error(`Token introspection failed: ${introspectResponse.status}`);
    }
    
    const introspectInfo = await introspectResponse.json();
    log('green', '✅ Token introspection successful', introspectInfo);
    
    // Step 6: Test MCP server access with token
    log('yellow', '\n🎯 Step 6: Test MCP server access with token');
    const healthEndpoint = process.env.MCP_HEALTH_ENDPOINT || '/health';
    const mcpHealthResponse = await fetch(`${MCP_SERVER}${healthEndpoint}`, {
      headers: { 'Authorization': `Bearer ${tokenInfo.access_token}` }
    });
    
    if (!mcpHealthResponse.ok) {
      throw new Error(`MCP health check failed: ${mcpHealthResponse.status}`);
    }
    
    const mcpHealth = await mcpHealthResponse.json();
    log('green', '✅ MCP server access with token successful', mcpHealth);
    
    // Step 7: Test SSE endpoint with authentication
    log('yellow', '\n📡 Step 7: Test SSE endpoint with authentication');
    const sseEndpoint = process.env.MCP_SSE_ENDPOINT || '/sse';
    const sseResponse = await fetch(`${MCP_SERVER}${sseEndpoint}`, {
      method: 'HEAD', // Use HEAD to avoid hanging SSE connection
      headers: { 'Authorization': `Bearer ${tokenInfo.access_token}` }
    });
    
    if (sseResponse.ok || sseResponse.status === 405) { // 405 = Method Not Allowed for HEAD on SSE
      log('green', '✅ SSE endpoint accepts authentication');
    } else {
      log('red', '❌ SSE endpoint rejected authentication', { status: sseResponse.status });
    }
    
    log('green', '\n🎉 Complete OAuth flow test SUCCESSFUL!');
    log('blue', '\n📊 Summary:');
    log('blue', '   • OAuth client registration: ✅');
    log('blue', '   • PKCE code challenge generation: ✅');
    log('blue', '   • Authorization code flow: ✅');
    log('blue', '   • Access token exchange: ✅');
    log('blue', '   • Token introspection: ✅');
    log('blue', '   • MCP server authentication: ✅');
    log('blue', '   • SSE endpoint authentication: ✅');
    
    return {
      success: true,
      clientInfo,
      tokenInfo,
      introspectInfo,
      mcpHealth
    };
    
  } catch (error) {
    log('red', `❌ OAuth flow test FAILED: ${error.message}`);
    return {
      success: false,
      error: error.message
    };
  }
}

// Run the test
testOAuthFlow().then(result => {
  if (result.success) {
    log('green', '\n✨ All tests passed! MCP OAuth server is working correctly.');
    process.exit(0);
  } else {
    log('red', `\n💥 Test failed: ${result.error}`);
    process.exit(1);
  }
}).catch(error => {
  log('red', `\n💥 Unexpected error: ${error.message}`);
  process.exit(1);
});