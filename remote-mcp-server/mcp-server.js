#!/usr/bin/env node

/**
 * Remote MCP Server for direct claude_desktop_config.json integration
 * This server acts as a bridge between Claude Desktop and remote machines via SSE
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

class RemoteMCPServer {
  constructor() {
    this.server = new Server(
      {
        name: "remote-mcp-server",
        version: "1.0.0",
        description: "Remote MCP Server for controlling remote machines via SSE"
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
  }

  setupToolHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "connect_remote",
            description: "Connect to a remote machine using device token",
            inputSchema: {
              type: "object",
              properties: {
                serverUrl: {
                  type: "string",
                  description: "Remote MCP Server URL (e.g., http://localhost:3002)",
                  default: "http://localhost:3002"
                },
                deviceToken: {
                  type: "string", 
                  description: "Device token for authentication"
                }
              },
              required: ["deviceToken"]
            },
          },
          {
            name: "remote_execute",
            description: "Execute MCP commands on connected remote machine",
            inputSchema: {
              type: "object",
              properties: {
                method: {
                  type: "string",
                  description: "MCP method to execute",
                  enum: ["read_file", "write_file", "list_directory", "start_process", "get_file_info", "create_directory", "move_file"]
                },
                params: {
                  type: "object",
                  description: "Parameters for the MCP method"
                }
              },
              required: ["method", "params"]
            },
          },
          {
            name: "remote_status",
            description: "Check remote connection status",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false
            }
          }
        ],
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case "connect_remote":
            return await this.handleConnect(args);
          case "remote_execute":
            return await this.handleExecute(args);
          case "remote_status":
            return await this.handleStatus(args);
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  async handleConnect(args) {
    const { serverUrl = "http://localhost:3002", deviceToken } = args;
    
    if (!deviceToken) {
      throw new Error("Device token is required");
    }

    try {
      // Store connection details for later use
      this.connectionConfig = { serverUrl, deviceToken };
      
      // Test the connection by checking server health
      const response = await fetch(`${serverUrl}/health`);
      if (!response.ok) {
        throw new Error(`Server not reachable: ${response.status}`);
      }

      const health = await response.json();
      
      return {
        content: [
          {
            type: "text",
            text: `✅ Connected to Remote MCP Server: ${serverUrl}\n` +
                  `Server Status: ${health.status}\n` +
                  `SSE Connections: ${health.sseConnections}\n` +
                  `Device Token: ${deviceToken.substring(0, 20)}...\n\n` +
                  `You can now use remote_execute to run commands on the remote machine.`,
          },
        ],
      };
    } catch (error) {
      throw new Error(`Failed to connect to remote server: ${error.message}`);
    }
  }

  async handleExecute(args) {
    if (!this.connectionConfig) {
      throw new Error("Not connected to remote server. Use connect_remote first.");
    }

    const { method, params } = args;
    const { serverUrl, deviceToken } = this.connectionConfig;

    try {
      const mcpRequest = {
        jsonrpc: "2.0",
        id: Date.now(),
        method,
        params
      };

      const response = await fetch(`${serverUrl}/api/mcp/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${deviceToken}`
        },
        body: JSON.stringify(mcpRequest)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`MCP execution failed: ${response.status} - ${errorText}`);
      }

      const result = await response.json();

      if (result.error) {
        throw new Error(`MCP Error: ${result.error.message}`);
      }

      return {
        content: [
          {
            type: "text", 
            text: `✅ Remote MCP command '${method}' executed successfully:\n\n` +
                  `${JSON.stringify(result.result, null, 2)}`
          },
        ],
      };
    } catch (error) {
      throw new Error(`Remote execution failed: ${error.message}`);
    }
  }

  async handleStatus(args) {
    if (!this.connectionConfig) {
      return {
        content: [
          {
            type: "text",
            text: "❌ Not connected to remote server. Use connect_remote to establish connection."
          },
        ],
      };
    }

    const { serverUrl, deviceToken } = this.connectionConfig;

    try {
      // Check server health
      const healthResponse = await fetch(`${serverUrl}/health`);
      const health = await healthResponse.json();

      // Check SSE status
      const sseResponse = await fetch(`${serverUrl}/sse/status`);
      const sseStatus = await sseResponse.json();

      return {
        content: [
          {
            type: "text",
            text: `🟢 Remote MCP Status:\n\n` +
                  `Server URL: ${serverUrl}\n` +
                  `Server Status: ${health.status}\n` +
                  `SSE Connections: ${health.sseConnections}\n` +
                  `Connected Devices: ${sseStatus.connectedDevices?.length || 0}\n` +
                  `Device Token: ${deviceToken.substring(0, 20)}...\n` +
                  `Last Updated: ${new Date().toISOString()}`
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `⚠️ Connection status check failed: ${error.message}\n` +
                  `Server URL: ${this.connectionConfig.serverUrl}\n` +
                  `You may need to reconnect using connect_remote.`
          },
        ],
      };
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Remote MCP Server running on stdio");
  }
}

// Start the server
const server = new RemoteMCPServer();
server.run().catch(console.error);