import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'url';
import { captureRemote } from '../utils/capture.js';

// Restart pacing: grows with consecutive failures, caps, and jitters so a
// fleet-wide fault does not stampede.
//
// The cap is what a user waits after fixing whatever broke the child, so it is
// deliberately short. It can be: readiness now keeps an unusable device out of
// the server's selection, so no routed calls arrive to spawn anything, and the
// only thing asking for a restart is this connector's own recovery loop. The
// cost of the short cap is one short-lived spawn every few seconds while a
// child stays broken; the cost of a long one is a device that sits dead for
// most a minute after it could have come back.
const RESTART_BACKOFF_CAP_MS = 5_000;
const restartBackoffMs = (attempt: number) =>
    // Cap AFTER jitter, so the cap is the wait this comment claims it is.
    Math.min(RESTART_BACKOFF_CAP_MS, 250 * 2 ** Math.min(attempt, 5) * (0.5 + Math.random()));

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
    /** Consecutive failed restarts; reset by a successful one. */
    private restartAttempts: number = 0;
    /** Before this, ensureReady() refuses rather than spawning again. */
    private nextRestartAt: number = 0;

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

            // Connect to Desktop Commander
            console.debug('[DEBUG] Connecting MCP client to transport');
            // shutdown() sets the flag and tears down what exists; it cannot
            // reach back into a restart already in flight. Without these
            // checks that restart carries on past the teardown, connects a
            // child nobody will close and sets `ready` behind it. The catch
            // below discards whatever this attempt built.
            this.abortIfShuttingDown();

            await this.mcpClient.connect(this.mcpTransport);
            this.abortIfShuttingDown();

            // Supervise the local half. Without these, a child crash is silent:
            // the SDK clears its transport and every subsequent call throws
            // "Not connected" with nothing tying it back to the death.
            //
            // These MUST hang off the client, not the transport. connect() wraps
            // transport.onclose/onerror with its own handlers and the SDK states
            // that "The Protocol object assumes ownership of the Transport,
            // replacing any callbacks that have already been set". Assigning to
            // the transport here instead would drop the SDK's wrapper, and with
            // it Protocol._onclose() — the only place a pending response is
            // rejected with ConnectionClosed. The call in flight when the child
            // died would then hang for the SDK's 60s default request timeout
            // before the user heard anything.
            this.mcpClient.onclose = () => this.handleLocalDisconnect('stdio transport closed');

            // Diagnostics only. Protocol.onerror is raised for eleven non-fatal
            // conditions that say nothing about the child's health — a response
            // for an unknown message id, an unknown progress token, a failed
            // cancellation send, an uncaught notification-handler error — and
            // treating any of those as death takes a working device offline and
            // respawns a live child. Real death arrives through onclose, which
            // only fires once the transport has actually closed.
            this.mcpClient.onerror = (err: Error) =>
                console.error(` - ⚠️  Local Desktop Commander MCP error: ${err?.message ?? String(err)}`);

            // Ready means the child has served a request, not that it
            // completed the handshake — one definition, whichever path
            // started the child, so no caller has to remember a second
            // step to get the stronger meaning. A failure here lands in
            // the catch below and leaves nothing half-built behind.
            await this.verifyExecution();
            this.abortIfShuttingDown();
            this.isReady = true;

            console.log(' - 🔌 Connected to Desktop Commander MCP');
            console.debug('[DEBUG] Desktop Commander MCP connection successful');

        } catch (error) {
            console.error(' - ❌ Failed to start Desktop Commander MCP:', error);
            console.debug('[DEBUG] MCP startup error:', error);
            // Leave no half-built child behind, or ensureReady() would treat
            // the corpse as live on the next attempt. Covers a child that
            // connected and then failed verification, too.
            await this.discardChild();
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
    /** Same refusal ensureReady() makes up front, for an attempt already running. */
    private abortIfShuttingDown(): void {
        if (this.isShuttingDown) {
            throw new Error('Desktop Commander integration is shutting down');
        }
    }

    async ensureReady(): Promise<void> {
        if (this.ready) return;
        if (this.isShuttingDown) {
            throw new Error('Desktop Commander integration is shutting down');
        }
        if (!this.reinitPromise) {
            // A child that crashes on start would otherwise be respawned once
            // per routed tool call. Refuse inside the window instead, so the
            // caller gets the real reason and the machine is left alone.
            const waitMs = this.nextRestartAt - Date.now();
            if (waitMs > 0) {
                throw new Error(
                    `Local Desktop Commander MCP failed to start ${this.restartAttempts} time(s); ` +
                    `next attempt in ${Math.ceil(waitMs / 1000)}s`
                );
            }
            console.log(' - ♻️  Local Desktop Commander MCP is not running; restarting it...');
            this.reinitPromise = this.restartChild().finally(() => {
                this.reinitPromise = null;
            });
        }
        // Concurrent calls share the single in-flight restart.
        await this.reinitPromise;
    }

    /** One restart, with the pacing bookkeeping around it. */
    private async restartChild(): Promise<void> {
        try {
            // initialize() resolves only once the child has served a request,
            // so there is nothing further to prove here.
            await this.initialize();
            this.restartAttempts = 0;
            this.nextRestartAt = 0;
        } catch (error) {
            await this.discardChild();
            this.restartAttempts++;
            this.nextRestartAt = Date.now() + restartBackoffMs(this.restartAttempts);
            throw error;
        }
    }

    /** Drop an unusable child so `ready` is false and the next attempt rebuilds. */
    private async discardChild(): Promise<void> {
        this.isReady = false;
        const client = this.mcpClient;
        const transport = this.mcpTransport;
        this.mcpClient = null;
        this.mcpTransport = null;
        try { await client?.close(); } catch { /* already dead */ }
        try { await transport?.close(); } catch { /* already dead */ }
    }

    /** How long ensureReady() will refuse for. 0 when it will try immediately. */
    get msUntilRestartAllowed(): number {
        return Math.max(0, this.nextRestartAt - Date.now());
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

        // Proxy other tools to MCP server
        try {
            console.debug('[DEBUG] Calling MCP tool:', toolName, 'args:', JSON.stringify(args).substring(0, 100));
            const result = await this.mcpClient!.callTool({
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

    /**
     * Prove the child can serve a request, not merely that it completed the
     * handshake. connect() only exchanges `initialize`, which says the process
     * is up and speaks MCP - the same substitution issue #4 is about, one level
     * down. Throws so initialize() can withhold readiness; listClientTools()
     * keeps swallowing, because registerDevice() wants a tool list or nothing.
     */
    private async verifyExecution(): Promise<void> {
        if (!this.mcpClient) throw new Error('Local Desktop Commander MCP is not connected');
        await this.mcpClient.listTools();
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
