import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface McpConfig {
    command: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
}

export class DesktopCommanderIntegration {
    private mcpClient: Client | null = null;
    private mcpTransport: StdioClientTransport | null = null;
    private isReady: boolean = false;

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

    async resolveMcpConfig(): Promise<McpConfig | null> {
        // Option 1: Development/Local Build
        // Adjusting path resolution since we are now in src/remote-device and dist is in root/dist
        // Original: path.resolve(__dirname, '../../dist/index.js')
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
            await new Promise<void>((resolve, reject) => {
                // Use 'which' to check if the command exists in PATH
                // We can't run it directly as it's an stdio MCP server that waits for input
                const check = spawn('which', [commandName]);
                check.on('error', reject);
                check.on('close', (code) => code === 0 ? resolve() : reject(new Error('Command not found')));
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

    async callClientTool(toolName: string, args: any, metadata?: any) {
        if (!this.isReady || !this.mcpClient) {
            throw new Error('DesktopIntegration not initialized');
        }

        // Proxy other tools to MCP server
        try {
            console.log(`Forwarding tool call ${toolName} to MCP server`, metadata);
            const result = await this.mcpClient.callTool({
                name: toolName,
                arguments: args,
                _meta: { remote: true, ...metadata || {} }
            } as any);
            return result;
        } catch (error) {
            console.error(`Error executing tool ${toolName}:`, error);
            throw error;
        }
    }

    async listClientTools() {
        if (!this.mcpClient) return { tools: [] };

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
    }
}
