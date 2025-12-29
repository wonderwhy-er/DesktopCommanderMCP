#!/usr/bin/env node

/**
 * OAuth Setup Test Script
 * Verifies that all OAuth components are working correctly
 */

const http = require('http');

async function testEndpoint(name, url, expectedStatus = 200) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const req = http.get(url, (res) => {
      const duration = Date.now() - startTime;
      const status = res.statusCode === expectedStatus ? '✅' : '❌';
      console.log(`${status} ${name}: ${res.statusCode} (${duration}ms)`);
      resolve(res.statusCode === expectedStatus);
    });
    
    req.on('error', (error) => {
      console.log(`❌ ${name}: ${error.message}`);
      resolve(false);
    });
    
    req.setTimeout(5000, () => {
      req.destroy();
      console.log(`❌ ${name}: timeout`);
      resolve(false);
    });
  });
}

async function testPostEndpoint(name, url, data, expectedStatus = 200) {
  return new Promise((resolve) => {
    const postData = JSON.stringify(data);
    const urlObj = new URL(url);
    
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const startTime = Date.now();
    const req = http.request(options, (res) => {
      const duration = Date.now() - startTime;
      const status = res.statusCode === expectedStatus ? '✅' : '❌';
      console.log(`${status} ${name}: ${res.statusCode} (${duration}ms)`);
      resolve(res.statusCode === expectedStatus);
    });
    
    req.on('error', (error) => {
      console.log(`❌ ${name}: ${error.message}`);
      resolve(false);
    });
    
    req.write(postData);
    req.end();
  });
}

async function testOAuthFlow() {
  return new Promise((resolve) => {
    const req = http.get('http://localhost:3003/auth/login', (res) => {
      const isRedirect = res.statusCode === 302;
      const location = res.headers.location;
      const hasValidLocation = location && location.includes('localhost:4444/oauth2/auth');
      const hasState = location && location.includes('state=');
      
      if (isRedirect && hasValidLocation && hasState) {
        // Extract state parameter to check length
        const stateMatch = location.match(/state=([^&]+)/);
        const stateLength = stateMatch ? stateMatch[1].length : 0;
        const hasValidState = stateLength >= 8;
        
        console.log(`${isRedirect && hasValidLocation && hasValidState ? '✅' : '❌'} OAuth Flow: redirect to Hydra (state length: ${stateLength})`);
        resolve(isRedirect && hasValidLocation && hasValidState);
      } else {
        console.log(`❌ OAuth Flow: invalid redirect (${res.statusCode})`);
        resolve(false);
      }
    });
    
    req.on('error', (error) => {
      console.log(`❌ OAuth Flow: ${error.message}`);
      resolve(false);
    });
  });
}

async function runTests() {
  console.log('🧪 Testing OAuth Setup...\n');
  
  console.log('📊 Core Services:');
  const mcpHealth = await testEndpoint('Remote MCP Server', 'http://localhost:3003/health');
  const kratosHealth = await testEndpoint('Kratos Health', 'http://localhost:4433/health/ready');
  const hydraHealth = await testEndpoint('Hydra Health', 'http://localhost:4445/health/ready');
  
  console.log('\n🔐 OAuth Endpoints:');
  const oauthFlow = await testOAuthFlow();
  const kratosAdmin = await testEndpoint('Kratos Admin', 'http://localhost:4434/admin/identities');
  const hydraAdmin = await testEndpoint('Hydra Admin', 'http://localhost:4445/admin/clients');
  
  console.log('\n🔧 OAuth Client:');
  const clientExists = await testEndpoint('OAuth Client Check', 'http://localhost:4445/admin/clients/remote-mcp-client');
  
  console.log('\n📝 Test Results:');
  const results = {
    'MCP Server': mcpHealth,
    'Kratos': kratosHealth,
    'Hydra': hydraHealth,
    'OAuth Flow': oauthFlow,
    'Kratos Admin': kratosAdmin,
    'Hydra Admin': hydraAdmin,
    'OAuth Client': clientExists
  };
  
  const passed = Object.values(results).filter(Boolean).length;
  const total = Object.keys(results).length;
  
  console.log(`\n${passed === total ? '🎉' : '⚠️'} Results: ${passed}/${total} tests passed\n`);
  
  if (passed === total) {
    console.log('✅ OAuth setup is working correctly!');
    console.log('🚀 Ready to use OAuth connector:');
    console.log('   ./mcp-server-oauth-connector.js');
  } else {
    console.log('❌ Some tests failed. Check the services:');
    Object.entries(results).forEach(([name, passed]) => {
      if (!passed) {
        console.log(`   - Fix: ${name}`);
      }
    });
  }
  
  console.log('\n📚 For help, see README.md OAuth troubleshooting section.');
}

runTests().catch(console.error);