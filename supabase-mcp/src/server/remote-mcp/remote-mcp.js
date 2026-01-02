import { ToolCallProcessor } from './tool-call-processor.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InMemoryEventStore } from '@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js';
import { z } from 'zod';
import { allTools } from './clientTools/client-tools.js';
import { mcpLogger, serverLogger } from '../../utils/logger.js';

/**
 * Remote MCP Manager
 * Handles MCP SDK integration, tools, and transports
 */
export class RemoteMcp {
    constructor(supabase) {
        this.supabase = supabase;
        this.toolDispatcher = new ToolCallProcessor(this.supabase);
        this.mcpEventStore = new InMemoryEventStore();
        this.mcpTransports = new Map();

        // Start cleanup interval (every 5 minutes)
        this.CLEANUP_INTERVAL = 5 * 60 * 1000;
        this.SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

        // Start cleanup loop
        setInterval(() => this._cleanupTransports(), this.CLEANUP_INTERVAL);

        // Initialize MCP SDK Server
        this.mcpServer = new McpServer(
            {
                name: 'desktop-commander-remote-mcp',
                version: '1.0.0'
            },
            {
                capabilities: {
                    tools: {
                        listChanged: true
                    },
                    logging: {}
                }
            }
        );

        this.setupMCPToolHandlers();
    }

    /**
     * Cleanup inactive transports to prevent memory leaks
     */
    _cleanupTransports() {
        const NOW = Date.now();
        let cleanedCount = 0;

        for (const [sessionId, transport] of this.mcpTransports.entries()) {
            if (NOW - (transport._lastActivity || 0) > this.SESSION_TIMEOUT) {
                this.mcpTransports.delete(sessionId);
                cleanedCount++;
            }
        }

        if (cleanedCount > 0) {
            serverLogger.info('🧹 Cleaned up inactive MCP sessions', { count: cleanedCount });
        }
    }

    /**
     * Setup MCP tools using the McpServer API
     */
    setupMCPToolHandlers() {
        mcpLogger.info('🔧 setupMCPToolHandlers() called', {});

        // Register only the list_agents tool
        this.mcpServer.registerTool('list_agents', {
            description: 'List connected agents for the current user',
            inputSchema: z.object({})
        }, async (args, extra = {}) => {
            mcpLogger.info('📋 [TOOL] list_agents called');
            const user = this.getAuthenticatedUser(extra);

            try {
                const agents = await this.toolDispatcher.getUserAgents(user.id);
                mcpLogger.info('✅ [TOOL] list_agents successful', { count: agents.length });

                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(agents, null, 2)
                    }]
                };
            } catch (error) {
                mcpLogger.error('❌ [TOOL] list_agents failed', { error: error.message });
                throw error;
            }
        });

        // Register remote tools from allTools configuration
        allTools.forEach(tool => {
            mcpLogger.info('Registering remote tool with MCP SDK', {
                toolName: tool.name
            });

            this.mcpServer.registerTool(
                tool.name,
                {
                    description: tool.description,
                    inputSchema: tool.inputSchema
                },
                async (args, extra = {}) => {
                    mcpLogger.info('🔧 Remote Tool called', {
                        toolName: tool.name,
                        argsReceived: !!args
                    });

                    const user = this.getAuthenticatedUser(extra);
                    mcpLogger.info('👤 [TOOL] Authenticated user:', { id: user.id });

                    // Dispatch to remote agent
                    try {
                        mcpLogger.info('🚀 Dispatching to remote agent', {
                            toolName: tool.name,
                            userId: user.id
                        });

                        const result = await this.toolDispatcher.dispatchTool(
                            user.id,
                            tool.name, // Tool name on agent side matches server side
                            args
                        );

                        mcpLogger.info('✅ Remote tool execution successful', {
                            toolName: tool.name
                        });
                        return result;
                    } catch (error) {
                        mcpLogger.error('❌ Remote tool execution failed', {
                            toolName: tool.name,
                            error: error.message
                        });
                        throw error;
                    }
                }
            );
        });

        mcpLogger.info('✅ Tool registration complete (list_agents + remote tools)');
        serverLogger.info(`MCP SDK registered ${allTools.length + 1} tools`);
    }

    /**
     * Get authenticated user from MCP request context
     */
    getAuthenticatedUser(extra) {
        const transport = extra.transport || this.mcpTransports.get(extra.sessionId);
        const authContext = transport?._authContext;
        const user = authContext?.user;

        if (!user) {
            throw new Error('User authentication required');
        }

        return user;
    }

    /**
     * Get or create MCP transport for a session
     */
    async getOrCreateMCPTransport(sessionId, user) {
        let transport = sessionId ? this.mcpTransports.get(sessionId) : undefined;

        if (!transport) {
            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => Date.now().toString() + '-' + Math.random().toString(36).substring(2),
                eventStore: this.mcpEventStore,
                retryInterval: 2000,
                onsessioninitialized: (id) => {
                    serverLogger.info('MCP session initialized', { sessionId: id, userId: user.id });
                    this.mcpTransports.set(id, transport);
                    transport._lastActivity = Date.now();
                }
            });

            // Store auth context for this transport
            transport._authContext = {
                user: user,
                supabase: this.supabase
            };

            // Connect the MCP server to the transport
            mcpLogger.info('🔗 Connecting MCP server to transport', {
                userId: user.id,
                sessionId
            });

            await this.mcpServer.connect(transport);

            mcpLogger.info('✅ MCP server connected to transport', {
                userId: user.id,
                sessionId
            });

            serverLogger.info('Created new MCP transport', { sessionId, userId: user.id });
        }

        // Update auth context for existing transport
        transport._authContext = {
            user: user,
            supabase: this.supabase
        };

        // Update activity timestamp
        transport._lastActivity = Date.now();

        return transport;
    }

    /**
     * Handle MCP protocol messages using session-based transports
     */
    async handleMCPMessageWithSDK(req, res) {
        const startTime = Date.now();
        const userId = req.user.id;

        try {
            const requestBody = req.body;
            const sessionId = req.headers['mcp-session-id'];

            mcpLogger.logMCPMessage(userId, requestBody?.method, requestBody?.id, 'RECEIVED');

            mcpLogger.info('📨 Processing MCP request', {
                userId,
                sessionId,
                method: requestBody?.method,
                id: requestBody?.id,
                hasParams: !!requestBody?.params
            });

            // Get or create transport for this session
            const transport = await this.getOrCreateMCPTransport(sessionId, req.user);

            mcpLogger.info('🔌 Transport ready', {
                userId,
                sessionId,
                isNewTransport: !sessionId || !this.mcpTransports.has(sessionId)
            });

            // Handle the request using the session transport
            mcpLogger.info('🚀 Delegating to transport.handleRequest', {
                userId,
                sessionId,
                method: requestBody?.method
            });

            // Log registered tools when tools/list is requested
            if (requestBody?.method === 'tools/list') {
                const registeredTools = Object.keys(this.mcpServer._registeredTools || {});
                mcpLogger.info('📊 McpServer internal state for tools/list', {
                    registeredToolCount: registeredTools.length,
                    registeredToolNames: registeredTools,
                    hasServer: !!this.mcpServer,
                    serverConnected: this.mcpServer.isConnected()
                });
            }

            // Intercept response to log it
            const originalJson = res.json;
            const originalSend = res.send;
            let responseLogged = false;

            res.json = function (data) {
                if (!responseLogged && requestBody?.method === 'tools/list') {
                    // mcpLogger.info('📋 tools/list RESPONSE BODY', {
                    //   tools: data?.result?.tools,
                    //   toolCount: data?.result?.tools?.length || 0,
                    //   fullResponse: data
                    // });
                    responseLogged = true;
                }
                return originalJson.call(this, data);
            };

            res.send = function (data) {
                if (!responseLogged && requestBody?.method === 'tools/list') {
                    try {
                        const parsed = typeof data === 'string' ? JSON.parse(data) : data;
                        // mcpLogger.info('📋 tools/list RESPONSE BODY (send)', {
                        //   tools: parsed?.result?.tools,
                        //   toolCount: parsed?.result?.tools?.length || 0,
                        //   fullResponse: parsed
                        // });
                    } catch (e) {
                        mcpLogger.info('📋 tools/list RESPONSE (raw)', { data });
                    }
                    responseLogged = true;
                }
                return originalSend.call(this, data);
            };

            await transport.handleRequest(req, res, requestBody);

            const duration = Date.now() - startTime;
            mcpLogger.logMCPMessage(userId, requestBody?.method, requestBody?.id, 'RESPONDED');

        } catch (error) {
            const duration = Date.now() - startTime;

            // Only send error response if headers haven't been sent yet
            if (!res.headersSent) {
                const errorResponse = {
                    jsonrpc: '2.0',
                    id: req.body?.id || null,
                    error: {
                        code: this._getErrorCode(error),
                        message: error.message,
                        data: process.env.DEBUG_MODE === 'true' ? error.stack : undefined
                    }
                };

                mcpLogger.error('MCP SDK request failed', {
                    userId,
                    method: req.body?.method,
                    duration: `${duration}ms`,
                    error: error.message
                });

                res.status(400).json(errorResponse);
            } else {
                mcpLogger.error('MCP SDK request failed (headers already sent)', {
                    userId,
                    method: req.body?.method,
                    duration: `${duration}ms`,
                    error: error.message
                });
            }
        }
    }

    /**
     * Get JSON-RPC error code for different error types
     */
    _getErrorCode(error) {
        if (error.message.includes('Unknown method')) return -32601;
        if (error.message.includes('Invalid Request')) return -32600;
        if (error.message.includes('Parse error')) return -32700;
        if (error.message.includes('Invalid params')) return -32602;
        return -32603; // Internal error
    }
}
