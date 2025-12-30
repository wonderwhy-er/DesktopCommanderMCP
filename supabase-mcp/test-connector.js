#!/usr/bin/env node

/**
 * Test connector for Supabase MCP Server
 * Simulates Claude Desktop connecting with OAuth flow
 */

import { spawn } from 'child_process';
import fetch from 'node-fetch';
import { createLogger } from './src/utils/logger.js';

const logger = createLogger('test-connector');

class SupabaseMCPConnector {
  constructor() {
    this.mcpServerUrl = 'http://localhost:3007';
    this.clientId = 'mcp-test-client';
    this.redirectUri = 'http://localhost:8847/callback';
    this.accessToken = null;
  }

  /**
   * Start OAuth authorization flow
   */
  async startOAuthFlow() {
    try {
      logger.info('🔐 Starting OAuth authorization flow...');
      
      // Step 1: Start OAuth flow
      const oauthParams = new URLSearchParams({
        response_type: 'code',
        client_id: this.clientId,
        redirect_uri: this.redirectUri,
        scope: 'mcp:tools',
        state: 'test-state'
      });
      
      const authUrl = `${this.mcpServerUrl}/authorize?${oauthParams.toString()}`;
      
      logger.info('🌐 OAuth authorization URL generated');
      logger.info(`Open this URL in your browser to authenticate:`);
      logger.info(`${authUrl}`);
      
      // Try to open browser automatically (macOS/Linux/Windows)
      const platform = process.platform;
      let openCommand;
      
      if (platform === 'darwin') {
        openCommand = 'open';
      } else if (platform === 'linux') {
        openCommand = 'xdg-open';
      } else if (platform === 'win32') {
        openCommand = 'start';
      }
      
      if (openCommand) {
        logger.info(`🚀 Attempting to open browser automatically...`);
        try {
          spawn(openCommand, [authUrl], { detached: true, stdio: 'ignore' });
          logger.info('✅ Browser opened successfully');
        } catch (error) {
          logger.warn('Failed to open browser automatically', error.message);
        }
      }
      
      logger.info('');
      logger.info('📋 Instructions:');
      logger.info('1. Browser should open automatically with the auth page');
      logger.info('2. Sign in or sign up with your Supabase account'); 
      logger.info('3. After authentication, copy the access_token from the URL');
      logger.info('4. Paste it here and press Enter');
      logger.info('');
      
      // Wait for user input
      return new Promise((resolve, reject) => {
        process.stdin.resume();
        process.stdin.setEncoding('utf8');
        
        logger.info('💫 Waiting for access token (paste and press Enter):');
        process.stdin.once('data', (data) => {
          const token = data.toString().trim();
          if (token && token.length > 10) {
            this.accessToken = token;
            logger.info('✅ Access token received');
            process.stdin.pause();
            resolve(token);
          } else {
            logger.error('❌ Invalid token received');
            process.stdin.pause();
            reject(new Error('Invalid access token'));
          }
        });
      });
      
    } catch (error) {
      logger.error('OAuth flow failed', null, error);
      throw error;
    }
  }

  /**
   * Test MCP connection with token
   */
  async testMCPConnection() {
    if (!this.accessToken) {
      throw new Error('No access token available');
    }

    try {
      logger.info('🔌 Testing MCP connection...');

      // Test tools endpoint
      const toolsResponse = await fetch(`${this.mcpServerUrl}/tools`, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (!toolsResponse.ok) {
        throw new Error(`Tools request failed: ${toolsResponse.status} ${toolsResponse.statusText}`);
      }

      const toolsData = await toolsResponse.json();
      logger.info('✅ Tools endpoint working');
      logger.info(`📋 Available tools: ${toolsData.tools?.length || 0}`);

      // Test MCP message
      const mcpMessage = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list'
      };

      const mcpResponse = await fetch(`${this.mcpServerUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(mcpMessage)
      });

      if (!mcpResponse.ok) {
        throw new Error(`MCP request failed: ${mcpResponse.status} ${mcpResponse.statusText}`);
      }

      const mcpData = await mcpResponse.json();
      logger.info('✅ MCP message endpoint working');
      logger.info(`🛠️  MCP tools: ${mcpData.result?.tools?.length || 0}`);
      
      if (mcpData.result?.tools?.length > 0) {
        logger.info('📋 Available MCP tools:');
        mcpData.result.tools.forEach(tool => {
          logger.info(`  - ${tool.name}: ${tool.description}`);
        });
      }

      return true;

    } catch (error) {
      logger.error('MCP connection test failed', null, error);
      throw error;
    }
  }

  /**
   * Run full test
   */
  async runTest() {
    try {
      logger.info('🧪 Starting Supabase MCP OAuth test...');
      logger.info('');

      // Step 1: OAuth flow
      await this.startOAuthFlow();
      logger.info('');

      // Step 2: Test MCP connection
      await this.testMCPConnection();
      
      logger.info('');
      logger.info('🎉 All tests passed! Supabase MCP OAuth is working correctly.');
      
    } catch (error) {
      logger.error('❌ Test failed', null, error);
      process.exit(1);
    }
  }
}

// Handle cleanup
process.on('SIGINT', () => {
  console.log('\n\n👋 Goodbye!');
  process.exit(0);
});

// Run test if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const connector = new SupabaseMCPConnector();
  connector.runTest().catch((error) => {
    console.error('Test failed:', error);
    process.exit(1);
  });
}