import { spawn } from 'child_process';
import path from 'path';

export class DesktopIntegration {
  constructor() {
    this.mcpServerPath = null;
    this.serverProcess = null;
    this.isReady = false;
  }

  async initialize() {
    // Find DesktopCommanderMCP installation
    this.mcpServerPath = await this.findDesktopCommanderMCP();
    if (!this.mcpServerPath) {
      throw new Error('DesktopCommanderMCP not found. Please install it first.');
    }

    console.log(`Found DesktopCommanderMCP at: ${this.mcpServerPath}`);
  }

  async findDesktopCommanderMCP() {
    // Common installation paths for DesktopCommanderMCP
    const possiblePaths = [
      // If installed globally
      'desktop-commander-mcp',
      // If installed locally
      './node_modules/.bin/desktop-commander-mcp',
      '../desktop-commander-mcp/dist/index.js',
      '../dist/index.js', // For development
      // Add more paths as needed
    ];

    for (const mcpPath of possiblePaths) {
      try {
        // Test if the MCP server exists and is executable
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
    // For now, implement a simple echo tool as stub
    // Later this will integrate with actual DesktopCommanderMCP
    if (toolName === 'remote_echo') {
      return {
        content: [{
          type: 'text',
          text: args.text || 'No text provided'
        }]
      };
    }

    // Placeholder for other tools
    throw new Error(`Tool ${toolName} not yet implemented in agent`);
  }

  async getCapabilities() {
    // Return available tools - for now just echo
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

  async shutdown() {
    if (this.serverProcess) {
      this.serverProcess.kill();
      this.serverProcess = null;
    }
  }
}