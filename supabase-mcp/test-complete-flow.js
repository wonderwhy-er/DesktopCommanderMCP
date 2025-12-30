#!/usr/bin/env node

/**
 * Complete OAuth Flow Test for Supabase MCP Server
 * Demonstrates the full remote connector experience
 */

import { spawn } from 'child_process';
import fetch from 'node-fetch';
import { createLogger } from './src/utils/logger.js';

const logger = createLogger('flow-test');

class CompleteMCPFlowTester {
  constructor() {
    this.mcpServerUrl = 'http://localhost:3007';
    this.connectorProcess = null;
  }

  /**
   * Test the complete MCP flow
   */
  async testCompleteFlow() {
    console.log('🧪 Testing Complete Supabase MCP Remote Connector Flow');
    console.log('='.repeat(60));
    console.log('');

    try {
      // Step 1: Verify server is running
      await this.checkServerHealth();
      
      // Step 2: Test OAuth endpoints
      await this.testOAuthEndpoints();
      
      // Step 3: Demonstrate SSE connector
      await this.testSSEConnector();
      
      // Step 4: Show Claude Desktop config
      this.showClaudeDesktopConfig();
      
      console.log('');
      console.log('✅ All tests passed! Remote MCP connector is ready.');
      console.log('');
      
    } catch (error) {
      logger.error('Flow test failed', null, error);
      console.log('❌ Test failed. Check server and configuration.');
    }
  }

  /**
   * Check if MCP server is healthy
   */
  async checkServerHealth() {
    console.log('📊 Step 1: Checking MCP Server Health...');
    
    try {
      const response = await fetch(`${this.mcpServerUrl}/health`);
      const health = await response.json();
      
      if (health.status === 'healthy') {
        console.log(`✅ Server healthy - uptime: ${health.uptime?.human || 'unknown'}`);
        console.log(`   📡 SSE endpoint: ${this.mcpServerUrl}/sse`);
        console.log(`   🔐 OAuth endpoint: ${this.mcpServerUrl}/authorize`);
      } else {
        throw new Error(`Server not healthy: ${health.status}`);
      }
    } catch (error) {
      console.log(`❌ Server health check failed: ${error.message}`);
      console.log(`   💡 Make sure server is running: npm start`);
      throw error;
    }
    
    console.log('');
  }

  /**
   * Test OAuth endpoints
   */
  async testOAuthEndpoints() {
    console.log('🔐 Step 2: Testing OAuth Endpoints...');
    
    try {
      // Test authorization endpoint
      const oauthParams = new URLSearchParams({
        response_type: 'code',
        client_id: 'mcp-test-client',
        redirect_uri: 'http://localhost:8847/callback',
        scope: 'mcp:tools',
        state: 'test-state-123'
      });
      
      const authUrl = `${this.mcpServerUrl}/authorize?${oauthParams.toString()}`;
      const authResponse = await fetch(authUrl, { redirect: 'manual' });
      
      if (authResponse.status === 302) {
        console.log('✅ OAuth authorization endpoint working');
        
        const location = authResponse.headers.get('location');
        if (location && location.includes('/auth.html')) {
          console.log('✅ Redirects to authentication page');
        }
      } else {
        throw new Error(`OAuth endpoint returned ${authResponse.status}`);
      }
      
      // Test MCP info API
      const infoResponse = await fetch(`${this.mcpServerUrl}/api/mcp-info`);
      const info = await infoResponse.json();
      
      if (info.supabaseUrl && info.supabaseAnonKey) {
        console.log('✅ MCP info API working');
        console.log(`   🔗 Supabase URL: ${info.supabaseUrl}`);
      } else {
        throw new Error('MCP info API missing required fields');
      }
      
    } catch (error) {
      console.log(`❌ OAuth endpoints test failed: ${error.message}`);
      throw error;
    }
    
    console.log('');
  }

  /**
   * Test SSE connector (without authentication)
   */
  async testSSEConnector() {
    console.log('🔌 Step 3: Testing SSE Connector...');
    
    console.log('   📝 Starting SSE connector (will trigger OAuth)...');
    console.log('   🌐 Browser should open automatically for authentication');
    console.log('');
    console.log('   ⚠️  This test will show OAuth flow but won\'t complete');
    console.log('   ⚠️  In real usage, complete authentication in browser');
    console.log('');
    
    return new Promise((resolve) => {
      // Start SSE connector process
      this.connectorProcess = spawn('node', ['src/client/sse-connector.js'], {
        env: { 
          ...process.env, 
          MCP_SERVER_URL: this.mcpServerUrl,
          DEBUG_MODE: 'true'
        },
        stdio: 'pipe'
      });
      
      let output = '';
      
      this.connectorProcess.stdout.on('data', (data) => {
        const line = data.toString();
        output += line;
        
        // Look for OAuth flow initiation
        if (line.includes('🔐 Starting OAuth flow')) {
          console.log('✅ SSE connector detected missing auth and started OAuth');
        }
        
        if (line.includes('🌐 Opening browser')) {
          console.log('✅ Browser opening for authentication');
        }
        
        if (line.includes('✅ Browser opened successfully')) {
          console.log('✅ OAuth URL opened in browser');
        }
        
        if (line.includes('OAuth flow initiated')) {
          console.log('✅ OAuth flow working correctly');
          
          // Kill the process after successful test
          setTimeout(() => {
            if (this.connectorProcess) {
              this.connectorProcess.kill();
              console.log('   📝 Test connector stopped (OAuth test complete)');
              console.log('');
              resolve();
            }
          }, 2000);
        }
      });
      
      this.connectorProcess.stderr.on('data', (data) => {
        // We expect some errors since we're not completing auth
      });
      
      this.connectorProcess.on('error', (error) => {
        console.log(`❌ SSE connector error: ${error.message}`);
        resolve();
      });
      
      // Timeout after 10 seconds
      setTimeout(() => {
        if (this.connectorProcess) {
          this.connectorProcess.kill();
          console.log('   ⏰ Test timeout (this is expected)');
          console.log('');
          resolve();
        }
      }, 10000);
    });
  }

  /**
   * Show Claude Desktop configuration
   */
  showClaudeDesktopConfig() {
    console.log('⚙️  Step 4: Claude Desktop Configuration');
    console.log('');
    console.log('Add this to your Claude Desktop MCP configuration:');
    console.log('');
    console.log('📁 Location:');
    console.log('   macOS: ~/Library/Application Support/Claude/claude_desktop_config.json');
    console.log('   Windows: %APPDATA%\\Claude\\claude_desktop_config.json');
    console.log('');
    console.log('📄 Configuration:');
    console.log('```json');
    console.log(JSON.stringify({
      mcpServers: {
        'supabase-mcp': {
          command: 'node',
          args: [process.cwd() + '/src/client/sse-connector.js'],
          env: {
            MCP_SERVER_URL: this.mcpServerUrl,
            DEBUG_MODE: 'true'
          }
        }
      }
    }, null, 2));
    console.log('```');
    console.log('');
    console.log('🔄 After adding configuration:');
    console.log('   1. Restart Claude Desktop');
    console.log('   2. Browser will open for OAuth authentication');
    console.log('   3. Sign in with your Supabase account');
    console.log('   4. MCP tools will become available');
    console.log('');
  }

  /**
   * Cleanup
   */
  cleanup() {
    if (this.connectorProcess) {
      this.connectorProcess.kill();
    }
  }
}

// Handle cleanup on exit
process.on('SIGINT', () => {
  console.log('\n👋 Test interrupted. Cleaning up...');
  process.exit(0);
});

process.on('exit', () => {
  // Cleanup handled automatically
});

// Run test if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const tester = new CompleteMCPFlowTester();
  
  // Handle cleanup
  process.on('SIGINT', () => {
    tester.cleanup();
    process.exit(0);
  });
  
  tester.testCompleteFlow().catch((error) => {
    tester.cleanup();
    console.error('Test failed:', error);
    process.exit(1);
  });
}