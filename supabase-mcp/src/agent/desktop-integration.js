import { spawn } from 'child_process';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export class DesktopIntegration {
  constructor() {
    this.mcpServerPath = null;
    this.mcpClient = null;
    this.mcpTransport = null;
    this.isReady = false;
  }

  async initialize() {
    // Find DesktopCommanderMCP installation
    this.mcpServerPath = await this.findDesktopCommanderMCP();
    if (!this.mcpServerPath) {
      throw new Error('DesktopCommanderMCP not found. Please install it first.');
    }

    console.log(`Found DesktopCommanderMCP at: ${this.mcpServerPath}`);

    try {
      console.log('🔌 Connecting to Desktop Commander MCP...');

      // Create stdio transport that will spawn Desktop Commander MCP
      this.mcpTransport = new StdioClientTransport({
        command: 'node',
        args: [this.mcpServerPath],
        // Use the directory of the MCP server as cwd
        cwd: path.dirname(this.mcpServerPath)
      });

      // Create MCP client
      this.mcpClient = new Client(
        {
          name: "desktop-integration-client",
          version: "1.0.0"
        },
        {
          capabilities: {}
        }
      );

      // Connect to Desktop Commander
      await this.mcpClient.connect(this.mcpTransport);
      this.isReady = true;

      console.log('✅ Connected to Desktop Commander MCP');

    } catch (error) {
      console.error('❌ Failed to connect to Desktop Commander MCP:', error);
      throw error;
    }
  }

  async findDesktopCommanderMCP() {
    // Common installation paths for DesktopCommanderMCP
    const possiblePaths = [
      // If installed globally
      'desktop-commander-mcp',
      // If installed locally
      '/Users/dasein/dev/DC/DesktopCommanderMCP/dist/index.js', // Hardcoded for this environment as seen in agent.js
      '../desktop-commander-mcp/dist/index.js',
      '../dist/index.js', // For development
      // Add more paths as needed
    ];

    for (const mcpPath of possiblePaths) {
      try {
        // Test if the MCP server exists and is executable
        // We use 'node' to execute it
        const testProcess = spawn('node', [mcpPath, '--version'], {
          stdio: 'pipe',
          timeout: 5000
        });

        await new Promise((resolve, reject) => {
          testProcess.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Exit code: ${code}`));
          });
          testProcess.on('error', reject);
        });

        return mcpPath;
      } catch (error) {
        // Continue to next path
      }
    }

    return null;
  }

  async executeTool(toolName, args) {
    if (!this.isReady) {
      throw new Error('DesktopIntegration not initialized');
    }

    // Keep remote_echo as a local tool
    if (toolName === 'remote_echo') {
      return {
        content: [{
          type: 'text',
          text: args.text || 'No text provided'
        }]
      };
    }

    // Proxy other tools to MCP server
    try {
      console.log(`Forwarding tool call ${toolName} to MCP server`);
      const result = await this.mcpClient.callTool({
        name: toolName,
        arguments: args
      });
      return result;
    } catch (error) {
      console.error(`Error executing tool ${toolName}:`, error);
      throw error;
    }
  }

  async getCapabilities() {
    if (!this.isReady) {
      // Return just local tools if not ready? Or throw?
      // Better to try connecting if not connected, but for now just fallback
      return {
        tools: [
          {
            name: 'remote_echo',
            description: 'Echo back text',
            inputSchema: {
              type: 'object',
              properties: {
                text: { type: 'string' }
              }
            }
          }
        ]
      };
    }

    try {
      // List tools from MCP server
      const mcpTools = await this.mcpClient.listTools();

      // Local tools
      const localTools = [
        {
          name: 'remote_echo',
          description: 'Echo back text',
          inputSchema: {
            type: 'object',
            properties: {
              text: { type: 'string' }
            }
          }
        }
      ];

      // Merge tools
      return {
        tools: [
          ...localTools,
          ...(mcpTools.tools || [])
        ]
      };
    } catch (error) {
      console.error('Error fetching capabilities:', error);
      // Fallback to local tools
      return {
        tools: [
          {
            name: 'remote_echo',
            description: 'Echo back text (Fallback)',
            inputSchema: {
              type: 'object',
              properties: {
                text: { type: 'string' }
              }
            }
          }
        ]
      };
    }
  }

  async shutdown() {
    if (this.mcpClient) {
      try {
        await this.mcpClient.close();
      } catch (e) {
        console.error('Error closing MCP client:', e);
      }
      this.mcpClient = null;
    }

    if (this.mcpTransport) {
      try {
        await this.mcpTransport.close();
      } catch (e) {
        console.error('Error closing MCP transport:', e);
      }
      this.mcpTransport = null;
    }

    this.isReady = false;
    this.serverProcess = null;
  }
}