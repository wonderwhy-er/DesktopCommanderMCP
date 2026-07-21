import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'url';
import { captureRemote } from '../utils/capture.js';

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
    private isShuttingDown: boolean = false;
    private disconnectHandler: ((reason: string) => void) | null = null;
    private reinitPromise: Promise<void> | null = null;

    /** True only while the local stdio child is actually reachable. */
    get ready(): boolean {
        return this.isReady && this.mcpClient !== null;
    }

    /**
     * Register a callback fired when the local MCP child dies unexpectedly.
     * The device uses this to stop advertising itself as online — the remote
     * channel staying healthy says nothing about the local half being alive.
     */
    onDisconnect(handler: (reason: string) => void) {
        this.disconnectHandler = handler;
    }

    /**
     * The local child exited or its pipe broke. Previously nothing observed this:
     * `isReady` was a one-shot latch set in initialize() and cleared only by
     * shutdown(), so every later callClientTool() sailed past the readiness guard
     * and died inside the SDK with a bare "Not connected", forever, while the
     * device still reported itself online.
     */
    private handleLocalDisconnect(reason: string) {
        if (this.isShuttingDown) return;   // expected teardown, not a fault
        if (!this.isReady) return;         // already handled; don't double-fire
        this.isReady = false;
        this.mcpClient = null;
        this.mcpTransport = null;
        console.error(` - ❌ Local Desktop Commander MCP went away (${reason}); will restart on next tool call`);
        void captureRemote('desktop_integration_local_disconnected', { reason });
        this.disconnectHandler?.(reason);
    }

    async initialize() {
        console.debug('[DEBUG] DesktopCommanderIntegration.initialize() called');
        const config = await this.resolveMcpConfig();

        if (!config) {
            console.debug('[DEBUG] No MCP config found');
            throw new Error('Desktop Commander MCP not found. Please install it globally via `npm install -g @wonderwhy-er/desktop-commander` or build the local project.');
        }

        console.log(` - ⏳ Connecting to Local Desktop Commander MCP using: ${config.command} ${config.args.join(' ')}`);
        console.debug('[DEBUG] MCP config:', JSON.stringify(config, null, 2));

        try {
            console.debug('[DEBUG] Creating StdioClientTransport');
            // DC_REMOTE_DEVICE tells the spawned server it is serving remote
            // services, so it suppresses local-only behavior like opening the
            // welcome page in a browser the remote user would never see.
            this.mcpTransport = new StdioClientTransport({
                ...config,
                env: { ...getDefaultEnvironment(), ...config.env, DC_REMOTE_DEVICE: 'true' }
            });

            // Create MCP client
            console.debug('[DEBUG] Creating MCP Client');
            this.mcpClient = new Client(
                {
                    name: "desktop-commander-client",
                    version: "1.0.0"
                },
                {
                    capabilities: {}
                }
            );

            // Supervise the local half. Without these, a child crash is silent:
            // the SDK clears its transport and every subsequent call throws
            // "Not connected" with nothing tying it back to the death.
            // Attached BEFORE connect(): the SDK chains handlers that already
            // exist on the transport, so its own close handling — which rejects
            // in-flight requests with "Connection closed" immediately — keeps
            // running. Assigned after connect() they would REPLACE the SDK's
            // handler and an in-flight call at child death would hang until
            // the 60s request timeout instead of failing fast.
            this.mcpTransport.onclose = () => this.handleLocalDisconnect('stdio transport closed');
            this.mcpTransport.onerror = (err: Error) =>
                this.handleLocalDisconnect(`stdio transport error: ${err?.message ?? String(err)}`);

            // Connect to Desktop Commander
            console.debug('[DEBUG] Connecting MCP client to transport');
            await this.mcpClient.connect(this.mcpTransport);
            this.isReady = true;

            console.log(' - 🔌 Connected to Desktop Commander MCP');
            console.debug('[DEBUG] Desktop Commander MCP connection successful');

        } catch (error) {
            console.error(' - ❌ Failed to connect to Desktop Commander MCP:', error);
            console.debug('[DEBUG] MCP connection error:', error);
            // Leave no half-built client behind, or ensureReady() would treat the
            // corpse as live on the next attempt.
            this.isReady = false;
            this.mcpClient = null;
            if (this.mcpTransport) {
                try {
                    await this.mcpTransport.close();
                } catch { /* already dead — nothing to salvage */ }
                this.mcpTransport = null;
            }
            await captureRemote('desktop_integration_init_failed', { error });
            throw error;
        }
    }

    /**
     * Guarantee a live local child before proxying a call, restarting it if the
     * previous one died. Restart is lazy (on demand) rather than a retry loop:
     * if the child is crashing on startup, each tool call fails with the real
     * reason instead of spinning respawns in the background.
     */
    async ensureReady(): Promise<void> {
        if (this.ready) return;
        if (this.isShuttingDown) {
            throw new Error('Desktop Commander integration is shutting down');
        }
        if (!this.reinitPromise) {
            console.log(' - ♻️  Local Desktop Commander MCP is not running; restarting it...');
            this.reinitPromise = this.initialize().finally(() => {
                this.reinitPromise = null;
            });
        }
        // Concurrent calls share the single in-flight restart.
        await this.reinitPromise;
    }

    async resolveMcpConfig(): Promise<McpConfig | null> {
        console.debug('[DEBUG] Resolving MCP config...');
        // Option 1: Development/Local Build
        // Adjusting path resolution since we are now in src/remote-device and dist is in root/dist
        // Original: path.resolve(__dirname, '../../dist/index.js')
        const devPath = path.resolve(__dirname, '../../dist/index.js');
        console.debug('[DEBUG] Checking local dev path:', devPath);
        try {
            await fs.access(devPath);
            console.debug(' - 🔍 Found local MCP server at:', devPath);
            return {
                command: process.execPath, // Use the current node executable
                args: [devPath],
                cwd: path.dirname(devPath)
            };
        } catch {
            console.debug('[DEBUG] Local dev path not found, trying global installation');
            // Local file not found, continue...
        }

        // Option 2: Global Installation
        const commandName = 'desktop-commander';
        console.debug('[DEBUG] Checking for global command:', commandName);
        try {
            await new Promise<void>((resolve, reject) => {
                // Use platform-appropriate command to check if the command exists in PATH
                // We can't run it directly as it's an stdio MCP server that waits for input
                const whichCommand = process.platform === 'win32' ? 'where' : 'which';
                console.debug('[DEBUG] Using platform command:', whichCommand, 'on platform:', process.platform);
                const check = spawn(whichCommand, [commandName], { windowsHide: true });  // Prevent visible console windows on Windows
                check.on('error', (err) => {
                    console.debug('[DEBUG] Spawn error for', whichCommand, ':', err.message);
                    reject(err);
                });
                check.on('close', (code) => {
                    console.debug('[DEBUG]', whichCommand, 'exited with code:', code);
                    return code === 0 ? resolve() : reject(new Error('Command not found'));
                });
            });
            console.debug(' - Found global desktop-commander CLI');
            return {
                command: commandName,
                args: []
            };
        } catch (err) {
            console.debug('[DEBUG] Global command not found:', err);
            // Global command not found
        }

        console.debug('[DEBUG] No MCP config resolved');
        return null;
    }

    async callClientTool(toolName: string, args: any, metadata?: any) {
        // Restart the child if it died since the last call, so a one-off crash
        // costs one failed call instead of wedging the device until a human
        // restarts `desktop-commander remote`.
        await this.ensureReady();

        // The child can die between ensureReady() resolving and the call below
        // (handleLocalDisconnect nulls the client); surface that as a clear
        // error instead of a TypeError on null.
        const client = this.mcpClient;
        if (!client) {
            throw new Error('Local Desktop Commander MCP connection was lost while dispatching; it will be restarted on the next call');
        }

        // Proxy other tools to MCP server
        try {
            console.debug('[DEBUG] Calling MCP tool:', toolName, 'args:', JSON.stringify(args).substring(0, 100));
            const result = await client.callTool({
                name: toolName,
                arguments: args,
                _meta: { remote: true, ...metadata || {} }
            } as any);
            console.debug('[DEBUG] Tool call successful:', toolName);
            return result;
        } catch (error) {
            console.error(`Error executing tool ${toolName}:`, error);
            console.debug('[DEBUG] Tool call error details:', error);
            await captureRemote('desktop_integration_tool_call_failed', { error, toolName });
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
            await captureRemote('desktop_integration_list_tools_failed', { error });
            // Fallback to local tools
            return {
                tools: []
            };
        }
    }

    async shutdown() {
        console.debug('[DEBUG] DesktopCommanderIntegration.shutdown() called');
        // Closing the transport fires onclose; flag this as intentional so it is
        // not reported as a crash.
        this.isShuttingDown = true;
        const closeWithTimeout = async (operation: () => Promise<void>, name: string, timeoutMs: number = 3000) => {
            return Promise.race([
                operation(),
                new Promise<void>((_, reject) =>
                    setTimeout(() => reject(new Error(`${name} timeout after ${timeoutMs}ms`)), timeoutMs)
                )
            ]);
        };

        if (this.mcpClient) {
            try {
                console.log('  → Closing MCP client...');
                console.debug('[DEBUG] Calling mcpClient.close() with timeout');
                await closeWithTimeout(
                    () => this.mcpClient!.close(),
                    'MCP client close'
                );
                console.log('  ✓ MCP client closed');
            } catch (e: any) {
                console.warn('  ⚠️  MCP client close timeout or error:', e.message);
                console.debug('[DEBUG] MCP client close error:', e);
                await captureRemote('desktop_integration_shutdown_error', { error: e, component: 'client' });
            }
            this.mcpClient = null;
        }

        if (this.mcpTransport) {
            try {
                console.log('  → Closing MCP transport...');
                console.debug('[DEBUG] Calling mcpTransport.close() with timeout');
                await closeWithTimeout(
                    () => this.mcpTransport!.close(),
                    'MCP transport close'
                );
                console.log('  ✓ MCP transport closed');
            } catch (e: any) {
                console.warn('  ⚠️  MCP transport close timeout or error:', e.message);
                console.debug('[DEBUG] MCP transport close error:', e);
                await captureRemote('desktop_integration_shutdown_error', { error: e, component: 'transport' });
            }
            this.mcpTransport = null;
        }

        this.isReady = false;
        console.debug('[DEBUG] Desktop Commander integration shutdown complete');
    }
}
