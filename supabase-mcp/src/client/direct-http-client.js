#!/usr/bin/env node

/**
 * Direct HTTP MCP Client
 * 
 * A direct HTTP transport client for MCP that Claude Desktop can use
 * to communicate with the Supabase MCP server without stdio transport.
 */

import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { createLogger } from '../utils/logger.js';
import { spawn } from 'child_process';

dotenv.config();

const logger = createLogger('direct-http-client');

/**
 * Direct HTTP MCP Client
 */
class DirectHTTPClient {
  constructor(serverUrl, accessToken) {
    this.serverUrl = serverUrl;
    this.accessToken = accessToken;
    this.clientId = 'claude-desktop';
    this.redirectUri = 'urn:ietf:wg:oauth:2.0:oob'; // Out-of-band redirect for desktop apps
    
    logger.info('Direct HTTP Client initialized', {
      serverUrl: this.serverUrl,
      hasAccessToken: !!this.accessToken
    });
  }
  
  /**
   * Discover OAuth configuration
   */
  async discoverOAuth() {
    try {
      const response = await fetch(`${this.serverUrl}/.well-known/oauth-authorization-server`);
      if (!response.ok) {
        throw new Error(`OAuth discovery failed: ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      logger.error('OAuth discovery failed', null, error);
      throw error;
    }
  }
  
  /**
   * Start OAuth flow
   */
  async startOAuthFlow() {
    try {
      const config = await this.discoverOAuth();
      
      // Generate PKCE parameters
      const codeVerifier = this.generateCodeVerifier();
      const codeChallenge = await this.generateCodeChallenge(codeVerifier);
      const state = Math.random().toString(36).substring(2);
      
      const authParams = new URLSearchParams({
        response_type: 'code',
        client_id: this.clientId,
        redirect_uri: this.redirectUri,
        scope: 'mcp:tools',
        state: state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256'
      });
      
      const authUrl = `${config.authorization_endpoint}?${authParams.toString()}`;
      
      // Open browser for authentication
      await this.openBrowser(authUrl);
      
      // Return configuration for manual handling
      return {
        authUrl,
        codeVerifier,
        state,
        tokenEndpoint: config.token_endpoint
      };
      
    } catch (error) {
      logger.error('OAuth flow failed', null, error);
      throw error;
    }
  }
  
  /**
   * Exchange authorization code for access token
   */
  async exchangeCodeForToken(code, codeVerifier, tokenEndpoint) {
    try {
      const tokenParams = {
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: this.redirectUri,
        client_id: this.clientId,
        code_verifier: codeVerifier
      };
      
      const response = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(tokenParams)
      });
      
      if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`Token exchange failed: ${response.status} - ${errorData}`);
      }
      
      return await response.json();
      
    } catch (error) {
      logger.error('Token exchange failed', null, error);
      throw error;
    }
  }
  
  /**
   * Send MCP request
   */
  async sendMCPRequest(method, params = {}) {
    if (!this.accessToken) {
      throw new Error('No access token available - authentication required');
    }
    
    const requestId = Date.now().toString() + '-' + Math.random().toString(36).substring(2);
    const request = {
      jsonrpc: '2.0',
      id: requestId,
      method: method,
      params: params
    };
    
    try {
      const response = await fetch(`${this.serverUrl}/mcp-direct`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.accessToken}`
        },
        body: JSON.stringify(request)
      });
      
      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('Authentication failed - token may be expired');
        }
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }
      
      const responseData = await response.json();
      
      if (responseData.error) {
        throw new Error(responseData.error.message || 'MCP request failed');
      }
      
      return responseData.result;
      
    } catch (error) {
      logger.error('MCP request failed', { method, requestId }, error);
      throw error;
    }
  }
  
  /**
   * Initialize MCP connection
   */
  async initialize(protocolVersion = '2024-11-05') {
    return await this.sendMCPRequest('initialize', {
      protocolVersion,
      clientInfo: {
        name: 'direct-http-client',
        version: '1.0.0'
      }
    });
  }
  
  /**
   * List available tools
   */
  async listTools() {
    return await this.sendMCPRequest('tools/list');
  }
  
  /**
   * Call a tool
   */
  async callTool(name, args = {}) {
    return await this.sendMCPRequest('tools/call', {
      name: name,
      arguments: args
    });
  }
  
  /**
   * Generate code verifier for PKCE
   */
  generateCodeVerifier() {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, dec => ('0' + dec.toString(16)).substr(-2)).join('');
  }
  
  /**
   * Generate code challenge for PKCE
   */
  async generateCodeChallenge(codeVerifier) {
    const encoder = new TextEncoder();
    const data = encoder.encode(codeVerifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  }
  
  /**
   * Open browser for authentication
   */
  async openBrowser(url) {
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
      try {
        spawn(openCommand, [url], { detached: true, stdio: 'ignore' });
        logger.info('Browser opened for authentication', { url });
      } catch (error) {
        logger.warn('Failed to open browser automatically', error.message);
        logger.info('Please open this URL manually:', url);
      }
    } else {
      logger.info('Please open this URL in your browser:', url);
    }
  }
}

// Export for use as module
export default DirectHTTPClient;

// Command-line interface
if (import.meta.url === `file://${process.argv[1]}`) {
  const serverUrl = process.env.MCP_SERVER_URL || 'http://localhost:3007';
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
  
  const client = new DirectHTTPClient(serverUrl, accessToken);
  
  async function demonstrateClient() {
    try {
      console.log('🔗 Demonstrating Direct HTTP MCP Client');
      console.log('=====================================');
      
      if (!accessToken) {
        console.log('❌ No access token provided');
        console.log('🔐 Starting OAuth flow...');
        
        const oauthConfig = await client.startOAuthFlow();
        
        console.log('\n📋 Complete these steps:');
        console.log('1. Browser should have opened with authentication page');
        console.log('2. Sign in with your Supabase account');
        console.log('3. Copy the authorization code from the final redirect');
        console.log('4. Set SUPABASE_ACCESS_TOKEN environment variable');
        console.log('5. Run this script again');
        
        return;
      }
      
      console.log('✅ Access token provided, testing MCP operations...\n');
      
      // Initialize
      console.log('📡 Initializing MCP connection...');
      const initResult = await client.initialize();
      console.log('✅ Initialization successful:', initResult.serverInfo?.name);
      
      // List tools
      console.log('\n📋 Listing available tools...');
      const tools = await client.listTools();
      console.log(`✅ Found ${tools.tools?.length || 0} tools:`);
      tools.tools?.forEach(tool => {
        console.log(`   • ${tool.name}: ${tool.description}`);
      });
      
      // Test echo tool
      if (tools.tools?.find(t => t.name === 'echo')) {
        console.log('\n🔊 Testing echo tool...');
        const echoResult = await client.callTool('echo', { text: 'Hello from Direct HTTP Client!' });
        console.log('✅ Echo result:', echoResult);
      }
      
      console.log('\n🎉 Direct HTTP MCP Client demonstration complete!');
      
    } catch (error) {
      console.error('❌ Client demonstration failed:', error.message);
      process.exit(1);
    }
  }
  
  demonstrateClient();
}