#!/usr/bin/env node

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { spawn } = require('child_process');
const fetch = require('cross-fetch');

/**
 * Local MCP Agent - Proxy Architecture
 * 
 * This agent acts as a proxy/bridge between:
 * 1. Remote MCP Server (via SSE) - receives requests
 * 2. Desktop Commander MCP Server (via stdio) - forwards requests
 * 
 * The agent does NOT implement MCP methods directly. Instead, it:
 * - Connects as an MCP client to Desktop Commander
 * - Forwards all MCP requests from Remote Server to Desktop Commander
 * - Returns Desktop Commander responses back to Remote Server
 */
class LocalMCPAgent {
  constructor(serverUrl, deviceToken, desktopCommanderPath) {
    this.serverUrl = serverUrl;
    this.deviceToken = deviceToken;
    this.sseUrl = `${serverUrl}/sse?deviceToken=${encodeURIComponent(deviceToken)}`;
    this.isConnected = false;

    // Desktop Commander MCP connection
    this.desktopCommanderPath = desktopCommanderPath || '/Users/dasein/dev/DC/DesktopCommanderMCP/dist/index.js';
    this.mcpClient = null;
    this.mcpTransport = null;
  }

  async start() {
    console.log('🚀 Starting Local MCP Agent (Proxy Mode)...');
    console.log(`🔗 Server URL: ${this.serverUrl}`);
    console.log(`🔑 Device Token: ${this.deviceToken.substring(0, 20)}...`);
    console.log(`🖥️  Desktop Commander Path: ${this.desktopCommanderPath}`);

    // First connect to Desktop Commander MCP
    await this.connectToDesktopCommander();

    // Then connect to Remote Server via SSE
    await this.connectSSE();
  }

  async connectToDesktopCommander() {
    try {
      console.log('🔌 Connecting to Desktop Commander MCP...');

      // Create stdio transport that will spawn Desktop Commander MCP
      this.mcpTransport = new StdioClientTransport({
        command: 'node',
        args: [this.desktopCommanderPath],
        cwd: '/Users/dasein/dev/DC/DesktopCommanderMCP'
      });

      // Create MCP client
      this.mcpClient = new Client(
        {
          name: "remote-mcp-agent",
          version: "1.0.0"
        },
        {
          capabilities: {}
        }
      );

      // Connect to Desktop Commander
      await this.mcpClient.connect(this.mcpTransport);

      console.log('✅ Connected to Desktop Commander MCP');

    } catch (error) {
      console.error('❌ Failed to connect to Desktop Commander MCP:', error);
      throw error;
    }
  }

  async connectSSE() {
    try {
      console.log(`📡 Connecting to SSE endpoint: ${this.sseUrl}`);

      // Use fetch with streaming for Node.js
      const response = await fetch(this.sseUrl, {
        headers: {
          'Accept': 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
      });

      if (!response.ok) {
        throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
      }

      console.log('✅ SSE connection established');
      this.isConnected = true;

      // Process the stream using Node.js readable stream
      let buffer = '';

      // Handle the response body as a Node.js readable stream
      response.body.on('data', (chunk) => {
        if (!this.isConnected) return;

        buffer += chunk.toString();

        // Process complete SSE messages
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        let eventType = null;
        let eventData = '';

        for (const line of lines) {
          if (line.trim()) {
            console.log(`📨 SSE line received: "${line}"`);
          }

          if (line.startsWith('event: ')) {
            eventType = line.substring(7);
            console.log(`🎯 Event type: ${eventType}`);
          } else if (line.startsWith('data: ')) {
            eventData = line.substring(6);
            console.log(`📦 Event data: ${eventData}`);

            // Process immediately when we have both type and data
            if (eventType && eventData) {
              console.log(`✅ Processing immediate SSE event: ${eventType}`);
              this.handleSSEEvent(eventType, eventData);
              eventType = null;
              eventData = '';
            }
          } else if (line === '') {
            // Empty line indicates end of event (backup)
            if (eventType && eventData) {
              console.log(`✅ Processing complete SSE event: ${eventType}`);
              this.handleSSEEvent(eventType, eventData);
              eventType = null;
              eventData = '';
            }
          }
        }
      });

      response.body.on('end', () => {
        console.log('🔌 SSE stream ended');
        this.isConnected = false;
      });

      response.body.on('error', (error) => {
        console.error('❌ SSE stream error:', error.message);
        this.isConnected = false;
      });
    } catch (error) {
      console.error('❌ SSE connection error:', error.message);
      this.isConnected = false;

      // Retry after 5 seconds
      setTimeout(() => {
        if (!this.isConnected) {
          console.log('🔄 Retrying SSE connection...');
          this.connectSSE();
        }
      }, 5000);
    }
  }

  handleSSEEvent(eventType, eventData) {
    try {
      const data = JSON.parse(eventData);

      switch (eventType) {
        case 'connected':
          console.log('🎉 Connected to Remote MCP Server');
          console.log(`📱 Device ID: ${data.deviceId}`);
          break;

        case 'mcp_request':
          console.log(`🔧 Received MCP request: ${data.request.method}`);
          this.handleMCPRequest(data.id, data.request);
          break;

        case 'heartbeat':
          // Silent heartbeat
          break;

        default:
          console.log(`📨 Unknown event: ${eventType}`, data);
      }
    } catch (error) {
      console.error('❌ Error processing SSE event:', error);
    }
  }

  async handleMCPRequest(requestId, request) {
    try {
      console.log(`   🔄 Forwarding to Desktop Commander: ${request.method}`);
      console.log(`   📝 Params:`, request.params);

      let result;

      // Forward request to Desktop Commander MCP based on method type
      if (request.method === 'tools/list') {
        // List available tools from Desktop Commander
        result = await this.mcpClient.listTools();
        console.log(`   📋 Retrieved ${result.tools?.length || 0} tools from Desktop Commander`);
        console.log(`list_tools result:`, result);
      } else if (request.method === 'tools/call') {
        // Execute tool on Desktop Commander
        const { name, arguments: args } = request.params;
        console.log(`   🔧 Executing tool: ${name} with args:`, args);
        result = await this.mcpClient.callTool({ name, arguments: args });
        console.log(`   📋 Retrieved result from Desktop Commander:`, result);
      } else if (request.method === 'initialize') {
        // Handle initialization request
        result = {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "remote-desktop-commander",
            version: "1.0.0"
          }
        };
      } else {
        // For unknown methods, return an error
        throw new Error(`Unsupported MCP method: ${request.method}. Supported: tools/list, tools/call`);
      }

      // Send successful response back to Remote Server
      await this.sendResponse(requestId, {
        jsonrpc: '2.0',
        id: request.id,
        result: result
      });

      console.log(`✅ MCP request ${request.method} completed via Desktop Commander`);

    } catch (error) {
      console.error(`❌ MCP request ${request.method} failed:`, error.message);

      // Send error response
      await this.sendError(requestId, error.message);
    }
  }

  async sendResponse(requestId, response) {
    try {
      await fetch(`${this.serverUrl}/sse/response`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          deviceToken: this.deviceToken,
          requestId: requestId,
          response: response
        })
      });
    } catch (error) {
      console.error('Failed to send response:', error);
    }
  }

  async sendError(requestId, errorMessage) {
    try {
      await fetch(`${this.serverUrl}/sse/error`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          deviceToken: this.deviceToken,
          requestId: requestId,
          error: errorMessage
        })
      });
    } catch (error) {
      console.error('Failed to send error:', error);
    }
  }

  async stop() {
    console.log('🛑 Stopping Local MCP Agent...');

    // Close SSE connection
    this.isConnected = false;

    // Disconnect from Desktop Commander MCP
    if (this.mcpClient) {
      try {
        await this.mcpClient.close();
      } catch (error) {
        console.error('Error closing MCP client:', error);
      }
    }

    // Close transport (this will terminate the process)
    if (this.mcpTransport) {
      try {
        await this.mcpTransport.close();
      } catch (error) {
        console.error('Error closing MCP transport:', error);
      }
    }

    console.log('✅ Agent stopped');
  }
}

// CLI Usage
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error('Usage: node agent.js <SERVER_URL> <DEVICE_TOKEN> [DESKTOP_COMMANDER_PATH]');
    console.error('Example: node agent.js http://localhost:3002 eyJhbGciOiJIUzI1NiI...');
    console.error('');
    console.error('Optional third argument: path to Desktop Commander index.js');
    console.error('Default: /Users/dasein/dev/DC/DesktopCommanderMCP/dist/index.js');
    process.exit(1);
  }

  const [serverUrl, deviceToken, desktopCommanderPath] = args;
  const agent = new LocalMCPAgent(serverUrl, deviceToken, desktopCommanderPath);

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\\n📴 Received SIGINT, shutting down gracefully...');
    agent.stop().then(() => process.exit(0));
  });

  process.on('SIGTERM', () => {
    console.log('\\n📴 Received SIGTERM, shutting down gracefully...');
    agent.stop().then(() => process.exit(0));
  });

  agent.start().catch(error => {
    console.error('💥 Agent failed to start:', error);
    process.exit(1);
  });
}