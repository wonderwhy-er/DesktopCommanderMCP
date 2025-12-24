#!/usr/bin/env node

/**
 * Remote MCP Server for direct claude_desktop_config.json integration
 * This server acts as a bridge between Claude Desktop and remote machines via SSE
 */

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");

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
            description: "Execute MCP tool commands on connected remote machine",
            inputSchema: {
              type: "object",
              properties: {
                toolName: {
                  type: "string",
                  description: "Desktop Commander tool to execute",
                  enum: ["read_file", "write_file", "list_directory", "start_process", "get_file_info", "create_directory", "move_file", "edit_block", "read_multiple_files", "write_pdf", "force_terminate", "list_sessions", "interact_with_process", "read_process_output", "list_processes", "kill_process", "start_search", "get_more_search_results", "stop_search", "list_searches", "get_config", "set_config_value"]
                },
                arguments: {
                  type: "object",
                  description: "Arguments for the tool"
                }
              },
              required: ["toolName", "arguments"]
            },
          },
          {
            name: "remote_list_tools",
            description: "List all available tools on the remote Desktop Commander",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false
            }
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
          case "remote_list_tools":
            return await this.handleListTools(args);
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

  async handleListTools(args) {
    if (!this.connectionConfig) {
      throw new Error("Not connected to remote server. Use connect_remote first.");
    }

    const { serverUrl, deviceToken } = this.connectionConfig;

    try {
      // Create MCP tools/list request for agent to forward to Desktop Commander
      const mcpRequest = {
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/list",
        params: {}
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
        throw new Error(`MCP list tools failed: ${response.status} - ${errorText}`);
      }

      const result = await response.json();

      if (result.error) {
        throw new Error(`MCP Error: ${result.error.message}`);
      }

      // Format the tools list nicely
      const tools = result.result?.tools || [];
      const toolsList = tools.map(tool => `• ${tool.name}: ${tool.description}`).join('\n');

      return {
        content: [
          {
            type: "text", 
            text: `✅ Remote Desktop Commander Tools (${tools.length} available):\n\n${toolsList}`
          },
        ],
      };
    } catch (error) {
      throw new Error(`Remote list tools failed: ${error.message}`);
    }
  }

  async handleExecute(args) {
    if (!this.connectionConfig) {
      throw new Error("Not connected to remote server. Use connect_remote first.");
    }

    const { toolName, arguments: toolArgs } = args;
    const { serverUrl, deviceToken } = this.connectionConfig;

    try {
      // Create MCP tool call request for agent to forward to Desktop Commander
      const mcpRequest = {
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
          name: toolName,
          arguments: toolArgs
        }
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
            text: `✅ Remote MCP tool '${toolName}' executed successfully:\n\n` +
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