import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class DesktopCommanderIntegration {
  constructor() {
    this.mcpServerPath = null;
    this.mcpClient = null;
    this.mcpTransport = null;
    this.isReady = false;
  }

  async initialize() {
    const config = await this.resolveMcpConfig();

    if (!config) {
      throw new Error('Desktop Commander MCP not found. Please install it globally via `npm install -g @wonderwhy-er/desktop-commander` or build the local project.');
    }

    console.log(` - ⏳ Connecting to Local Desktop Commander MCP using: ${config.command} ${config.args.join(' ')}`);

    try {
      this.mcpTransport = new StdioClientTransport(config);

      // Create MCP client
      this.mcpClient = new Client(
        {
          name: "desktop-commander-client",
          version: "1.0.0"
        },
        {
          capabilities: {}
        }
      );

      // Connect to Desktop Commander
      await this.mcpClient.connect(this.mcpTransport);
      this.isReady = true;

      console.log(' - 🔌 Connected to Desktop Commander MCP');

    } catch (error) {
      console.error(' - ❌ Failed to connect to Desktop Commander MCP:', error);
      throw error;
    }
  }

  async resolveMcpConfig() {
    // Option 1: Development/Local Build
    const devPath = path.resolve(__dirname, '../../dist/index.js');
    try {
      await fs.access(devPath);
      console.debug(' - 🔍 Found local MCP server at:', devPath);
      return {
        command: process.execPath, // Use the current node executable
        args: [devPath],
        cwd: path.dirname(devPath)
      };
    } catch {
      // Local file not found, continue...
    }

    // Option 2: Global Installation
    const commandName = 'desktop-commander';
    try {
      await new Promise((resolve, reject) => {
        // Use 'which' to check if the command exists in PATH
        // We can't run it directly as it's an stdio MCP server that waits for input
        const check = spawn('which', [commandName]);
        check.on('error', reject);
        check.on('close', (code) => code === 0 ? resolve() : reject());
      });
      console.debug(' - Found global desktop-commander CLI');
      return {
        command: commandName,
        args: []
      };
    } catch {
      // Global command not found
    }

    return null;
  }

  async executeTool(toolName, args) {
    if (!this.isReady) {
      throw new Error('DesktopIntegration not initialized');
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

    try {
      // List tools from MCP server
      const mcpTools = await this.mcpClient.listTools();

      // Merge tools
      return {
        tools: mcpTools.tools || []
      };
    } catch (error) {
      console.error('Error fetching capabilities:', error);
      // Fallback to local tools
      return {
        tools: []
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