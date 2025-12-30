#!/usr/bin/env node

/**
 * Supabase HTTP MCP Connector
 * 
 * A direct HTTP-based MCP connector that communicates with the Supabase MCP server
 * using OAuth 2.0 authentication and HTTP transport for the MCP protocol.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  InitializeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { createLogger } from '../utils/logger.js';
import { spawn } from 'child_process';

dotenv.config();

const logger = createLogger('http-connector');

/**
 * HTTP-based MCP connector for Supabase MCP Server
 */
class SupabaseHTTPConnector {
  constructor() {
    // Configuration
    this.mcpServerUrl = process.env.MCP_SERVER_URL || 'http://localhost:3007';
    this.accessToken = process.env.SUPABASE_ACCESS_TOKEN;
    this.clientId = process.env.OAUTH_CLIENT_ID || 'mcp-connector';
    this.redirectUri = process.env.OAUTH_REDIRECT_URI || 'http://localhost:8847/callback';
    
    // State
    this.isAuthenticated = false;
    this.requestTimeout = 30000; // 30 seconds
    
    // MCP Server instance
    this.server = new Server(
      {
        name: 'supabase-http-connector',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
          logging: {}
        },
      }
    );
    
    this.setupHandlers();
    this.validateConfiguration();
    
    logger.info('Supabase HTTP Connector initialized', {
      mcpServerUrl: this.mcpServerUrl,
      hasAccessToken: !!this.accessToken,
      clientId: this.clientId
    });
  }
  
  /**
   * Validate configuration
   */
  validateConfiguration() {
    if (!this.mcpServerUrl) {
      throw new Error('MCP_SERVER_URL environment variable is required');
    }
    
    // Access token is optional - if not provided, we'll trigger OAuth flow
    if (!this.accessToken) {
      logger.info('No access token provided - OAuth flow will be initiated');
    }
  }
  
  /**
   * Setup MCP request handlers
   */
  setupHandlers() {
    // Initialize handler
    this.server.setRequestHandler(InitializeRequestSchema, async (request) => {
      logger.info('Initialize request received', request.params);
      
      // Ensure authentication
      await this.ensureAuthenticated();
      
      return {
        protocolVersion: request.params.protocolVersion || '2024-11-05',
        capabilities: {
          tools: {},
          logging: {}
        },
        serverInfo: {
          name: 'supabase-http-connector',
          version: '1.0.0'
        },
        instructions: 'Connected to Supabase MCP Server via HTTP. You can now use the available tools.'
      };
    });
    
    // List tools handler
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      logger.info('List tools request received');
      
      try {
        await this.ensureAuthenticated();
        const response = await this.sendMCPRequest('tools/list', {});
        return response;
      } catch (error) {
        logger.error('Failed to list tools', null, error);
        throw new Error(`Failed to list tools: ${error.message}`);
      }
    });
    
    // Call tool handler
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      
      logger.info('Tool call request received', { toolName: name, args });
      
      try {
        await this.ensureAuthenticated();
        const response = await this.sendMCPRequest('tools/call', {
          name,
          arguments: args || {}
        });
        return response;
      } catch (error) {
        logger.error('Tool call failed', { toolName: name }, error);
        throw new Error(`Tool call failed: ${error.message}`);
      }
    });
  }
  
  /**
   * Ensure authentication
   */
  async ensureAuthenticated() {
    if (this.isAuthenticated && this.accessToken) {
      return;
    }
    
    if (!this.accessToken) {
      await this.startOAuthFlow();
      return;
    }
    
    // Test if current token is valid
    try {
      await this.testServerConnection();
      this.isAuthenticated = true;
    } catch (error) {
      logger.warn('Access token validation failed', error.message);
      await this.startOAuthFlow();
    }
  }
  
  /**
   * Start OAuth flow to get access token
   */
  async startOAuthFlow() {
    try {
      logger.info('🔐 Starting OAuth flow...');
      
      // Generate OAuth parameters with PKCE
      const state = Math.random().toString(36).substring(2);
      const codeVerifier = this.generateCodeVerifier();
      const codeChallenge = await this.generateCodeChallenge(codeVerifier);
      
      const oauthParams = new URLSearchParams({
        response_type: 'code',
        client_id: this.clientId,
        redirect_uri: this.redirectUri,
        scope: 'mcp:tools',
        state: state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256'
      });
      
      const authUrl = `${this.mcpServerUrl}/authorize?${oauthParams.toString()}`;
      
      logger.info('🌐 Opening browser for authentication...');
      logger.info(`Auth URL: ${authUrl}`);
      
      // Try to open browser automatically
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
          spawn(openCommand, [authUrl], { detached: true, stdio: 'ignore' });
          logger.info('✅ Browser opened successfully');
        } catch (error) {
          logger.warn('Failed to open browser automatically', error.message);
        }
      }
      
      logger.info('');
      logger.info('📋 Please complete authentication in your browser');
      logger.info('🔄 After authentication, set the SUPABASE_ACCESS_TOKEN environment variable');
      logger.info('💫 Then restart the connector to continue...');
      
      throw new Error('OAuth flow initiated - please complete authentication in browser and set SUPABASE_ACCESS_TOKEN environment variable');
      
    } catch (error) {
      logger.error('OAuth flow failed', null, error);
      throw error;
    }
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
   * Test server connection
   */
  async testServerConnection() {
    try {
      logger.debug('Testing server connection...');
      
      const response = await fetch(`${this.mcpServerUrl}/health`, {
        method: 'GET',
        timeout: 5000
      });
      
      if (!response.ok) {
        throw new Error(`Server health check failed: ${response.status} ${response.statusText}`);
      }
      
      const health = await response.json();
      logger.info('Server health check passed', { status: health.status, uptime: health.uptime?.human });
      
    } catch (error) {
      logger.error('Server health check failed', null, error);
      throw new Error(`Cannot connect to MCP server at ${this.mcpServerUrl}: ${error.message}`);
    }
  }
  
  /**
   * Send MCP request to server
   */
  async sendMCPRequest(method, params) {
    if (!this.accessToken) {
      throw new Error('Not authenticated - access token required');
    }
    
    const requestId = Date.now().toString() + '-' + Math.random().toString(36).substring(2);
    const request = {
      jsonrpc: '2.0',
      id: requestId,
      method,
      params
    };
    
    logger.info('Sending MCP request', { 
      requestId, 
      method, 
      hasParams: !!params 
    });
    
    try {
      // Send HTTP request to MCP endpoint
      const response = await fetch(`${this.mcpServerUrl}/mcp-direct`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.accessToken}`,
          'Accept': 'application/json'
        },
        body: JSON.stringify(request),
        timeout: this.requestTimeout
      });
      
      if (!response.ok) {
        // Handle authentication errors
        if (response.status === 401) {
          this.isAuthenticated = false;
          throw new Error('Authentication failed - access token may be expired');
        }
        
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }
      
      const responseData = await response.json();
      
      // Handle JSON-RPC errors
      if (responseData.error) {
        throw new Error(responseData.error.message || 'MCP request failed');
      }
      
      logger.info('MCP request completed', { 
        requestId, 
        hasResult: !!responseData.result 
      });
      
      return responseData.result;
      
    } catch (error) {
      logger.error('Failed to send MCP request', { requestId, method }, error);
      throw error;
    }
  }
  
  /**
   * Start the connector
   */
  async start() {
    try {
      logger.info('Starting Supabase HTTP Connector...');
      
      // Test server connection
      await this.testServerConnection();
      
      // Start MCP server transport
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      
      logger.info('✅ Supabase HTTP Connector started successfully');
      
      // Handle graceful shutdown
      process.on('SIGINT', () => this.shutdown());
      process.on('SIGTERM', () => this.shutdown());
      
    } catch (error) {
      logger.error('Failed to start connector', null, error);
      throw error;
    }
  }
  
  /**
   * Graceful shutdown
   */
  async shutdown() {
    logger.info('Shutting down Supabase HTTP Connector...');
    
    try {
      logger.info('✅ Supabase HTTP Connector shutdown complete');
      process.exit(0);
      
    } catch (error) {
      logger.error('Error during shutdown', null, error);
      process.exit(1);
    }
  }
}

// Start connector if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const connector = new SupabaseHTTPConnector();
  connector.start().catch(error => {
    console.error('Failed to start Supabase HTTP Connector:', error);
    process.exit(1);
  });
}

export default SupabaseHTTPConnector;