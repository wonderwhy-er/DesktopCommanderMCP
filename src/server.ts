import path from 'path';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    ListResourcesRequestSchema,
    ReadResourceRequestSchema,
    ListResourceTemplatesRequestSchema,
    ListPromptsRequestSchema,
    InitializeRequestSchema,
    LATEST_PROTOCOL_VERSION,
    SUPPORTED_PROTOCOL_VERSIONS,
    type CallToolRequest,
    type InitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { getSystemInfo, getOSSpecificGuidance, getPathGuidance, getDevelopmentToolGuidance } from './utils/system-info.js';

// Get system information once at startup
const SYSTEM_INFO = getSystemInfo();
const OS_GUIDANCE = getOSSpecificGuidance(SYSTEM_INFO);
const DEV_TOOL_GUIDANCE = getDevelopmentToolGuidance(SYSTEM_INFO);
const PATH_GUIDANCE = `${getPathGuidance(SYSTEM_INFO)} Relative paths depend on the current working directory, and tilde paths (~/...) may not resolve in every context. Absolute paths are generally the most reliable.`;

const CMD_PREFIX_DESCRIPTION = `This command can be referenced as "DC: ..." or "use Desktop Commander to ..." in your instructions.`;

const SERVER_INSTRUCTIONS = `Desktop Commander provides tools for working with the user's authorized device.
- Filesystem tools handle direct file and directory operations within configured access boundaries.
- Terminal process tools support shell commands, REPLs, and long-running processes. start_process creates a process session; interact_with_process sends input; read_process_output reads later output; force_terminate ends a session.
- Search tools are session-based. start_search creates a search session; get_more_search_results reads its results; stop_search ends it early.
- Host platform: ${SYSTEM_INFO.platformName}; configured default shell: ${SYSTEM_INFO.defaultShell}.
- The optional origin argument is reserved for UI/internal provenance; model-initiated calls omit it.
- Absolute paths are generally the most reliable because relative paths depend on the active working directory.
- allowedDirectories and each tool's schema, annotations, and documented constraints define the operational boundaries.`;

import {
    StartProcessArgsSchema,
    ReadProcessOutputArgsSchema,
    InteractWithProcessArgsSchema,
    ForceTerminateArgsSchema,
    ListSessionsArgsSchema,
    KillProcessArgsSchema,
    ReadFileArgsSchema,
    ReadMultipleFilesArgsSchema,
    WriteFileArgsSchema,
    CreateDirectoryArgsSchema,
    ListDirectoryArgsSchema,
    MoveFileArgsSchema,
    GetFileInfoArgsSchema,
    GetConfigArgsSchema,
    SetConfigValueArgsSchema,
    ListProcessesArgsSchema,
    EditBlockArgsSchema,
    GetUsageStatsArgsSchema,
    GiveFeedbackArgsSchema,
    StartSearchArgsSchema,
    GetMoreSearchResultsArgsSchema,
    StopSearchArgsSchema,
    ListSearchesArgsSchema,
    GetRecentToolCallsArgsSchema,
    WritePdfArgsSchema,
    toolArgSchemas,
} from './tools/schemas.js';
import {
    detectUnsupportedParams,
    getSupportedParams,
    buildUnsupportedParamsWarning,
} from './utils/unsupportedParams.js';
import { getConfig, setConfigValue } from './tools/config.js';
import { getUsageStats } from './tools/usage.js';
import { giveFeedbackToDesktopCommander } from './tools/feedback.js';
import { trackToolCall } from './utils/trackTools.js';
import { usageTracker } from './utils/usageTracker.js';
import { processDockerPrompt } from './utils/dockerPrompt.js';
import { toolHistory } from './utils/toolHistory.js';
import { handleWelcomePageOnboarding, skipWelcomePageOnboarding } from './utils/welcome-onboarding.js';

import { VERSION } from './version.js';
import { addToolCallPaths, capture, capture_call_tool, runInUiOriginCallContext, runWithToolCallPaths } from "./utils/capture.js";
import { logToStderr, logger } from './utils/logger.js';
import {
    buildUiToolMeta,
    CONFIG_EDITOR_RESOURCE_URI,
    FILE_PREVIEW_RESOURCE_URI,
} from './ui/contracts.js';
import { listUiResources, readUiResource } from './ui/resources.js';
import { shouldShowMcpUiPreviews } from './utils/mcp-ui-ab-test.js';

// Store startup messages to send after initialization
const deferredMessages: Array<{ level: string, message: string }> = [];
function deferLog(level: string, message: string) {
    deferredMessages.push({ level, message });
}

// Function to flush deferred messages after initialization
export function flushDeferredMessages() {
    while (deferredMessages.length > 0) {
        const msg = deferredMessages.shift()!;
        logger.info(msg.message);
    }
}

deferLog('info', 'Loading server.ts');

export const server = new Server(
    {
        name: "desktop-commander",
        version: VERSION,
    },
    {
        capabilities: {
            tools: {},
            resources: {},  // Add empty resources capability
            prompts: {},    // Add empty prompts capability
            logging: {},    // Add logging capability for console redirection
        },
    },
);

// Add handler for resources/list method
server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
        resources: listUiResources(),
    };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    const response = await readUiResource(uri);
    if (response) {
        return response;
    }

    throw new Error(`Unknown resource URI: ${uri}`);
});

// Add handler for prompts/list method
server.setRequestHandler(ListPromptsRequestSchema, async () => {
    // Return an empty list of prompts
    return {
        prompts: [],
    };
});

// Store current client info (simple variable)
let currentClient = { name: 'uninitialized', version: 'uninitialized' };

// Tracks whether the in-flight tool call originated from a remote device.
// Mirrors the module-level `currentClient` pattern so that telemetry events
// emitted deeper inside tool handlers (e.g. server_start_process,
// server_read_file) can be attributed to the remote path. The CallTool
// handler sets this on every call (true when _meta.remote is present,
// false otherwise) so the flag never leaks from a remote call to a
// subsequent local call.
let currentCallIsRemote = false;

/**
 * Set whether the current tool call is from a remote device.
 * Called once per tool call by the CallTool handler.
 */
function setCurrentCallIsRemote(isRemote: boolean) {
    currentCallIsRemote = isRemote;
}

// The remote caller's client for the in-flight tool call (e.g. openai-mcp,
// claude-ai). Set per CallTool when the call is remote; null for local calls.
// Mirrors currentCallIsRemote so telemetry attributes remote events to the
// actual remote client instead of the device's own currentClient (which stays
// LOCAL and must not be polluted by remote callers).
let currentRemoteClient: { name?: string; version?: string } | null = null;

/**
 * Set the remote caller's client for the current tool call (null when local).
 * Called once per tool call by the CallTool handler.
 */
function setCurrentRemoteClient(clientInfo: { name?: string; version?: string } | null) {
    currentRemoteClient = clientInfo;
}

/**
 * True when this server instance is serving remote services rather than a
 * local MCP client. The remote-device wrapper marks the server it spawns with
 * DC_REMOTE_DEVICE=true (see remote-device/desktop-commander-integration.ts);
 * the client-name check covers older wrappers that predate the env marker.
 */
function isRemoteClientContext(clientName?: string): boolean {
    return process.env.DC_REMOTE_DEVICE === 'true' || clientName === 'desktop-commander-client';
}

/**
 * Unified way to update client information
 */
async function updateCurrentClient(clientInfo: { name?: string, version?: string }) {
    if (clientInfo.name !== currentClient.name || clientInfo.version !== currentClient.version) {
        const nameChanged = clientInfo.name !== currentClient.name;

        currentClient = {
            name: clientInfo.name || currentClient.name,
            version: clientInfo.version || currentClient.version
        };

        // Configure transport for client-specific behavior only if name changed
        if (nameChanged) {
            const transport = (global as any).mcpTransport;
            if (transport && typeof transport.configureForClient === 'function') {
                transport.configureForClient(currentClient.name);
            }
        }

        return true;
    }
    return false;
}

// Add handler for initialization method - capture client info
server.setRequestHandler(InitializeRequestSchema, async (request: InitializeRequest) => {
    try {
        // Extract and store current client information
        const clientInfo = request.params?.clientInfo;
        if (clientInfo) {
            await updateCurrentClient(clientInfo);

            // Welcome page for new users (A/B test controlled) — all clients except
            // the Desktop Commander app and remote contexts. Further exclusions are
            // flag-served via welcome_page_excluded_clients (e.g. claude-code, which
            // covers Claude Code and Cowork plugin sessions — both identify as
            // `claude-code` and provide their own onboarding surface).
            const isWelcomePageEligibleClient = currentClient.name !== 'desktop-commander-app'
                && currentClient.name !== 'desktop-commander'
                && !isRemoteClientContext(currentClient.name)
                && !(global as any).disableOnboarding;

            if (isWelcomePageEligibleClient) {
                await handleWelcomePageOnboarding(currentClient.name);
            } else {
                // Do not carry a first-run page over to a client that is made
                // eligible in a later release.
                await skipWelcomePageOnboarding();
            }
        }

        // Raw host environment signals (no PII, undefined when absent). Some
        // hosts share a clientInfo name — Claude Code CLI, Claude Code inside
        // the Claude Desktop app, and Cowork all report 'claude-code' — and
        // these let analytics tell them apart without client-specific
        // branching in code. Verified signatures: CLI → entrypoint 'cli';
        // CC-in-desktop → entrypoint 'claude-desktop'; Cowork → no
        // entrypoint/agent, plugin id 'desktop-commander-inline'.
        // Values truncated to GA4's 100-char param limit (same convention as
        // containerName/containerImage) so an oversized value can never get
        // the whole event rejected.
        capture('run_server_mcp_initialized', {
            host_entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT?.substring(0, 100),
            host_agent: process.env.AI_AGENT?.substring(0, 100),
            host_plugin_id: process.env.CLAUDE_PLUGIN_DATA
                ? path.basename(process.env.CLAUDE_PLUGIN_DATA).substring(0, 100) : undefined
        });

        // Negotiate protocol version with client
        const requestedVersion = request.params?.protocolVersion;
        const protocolVersion = (requestedVersion && SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion))
            ? requestedVersion
            : LATEST_PROTOCOL_VERSION;

        // Return standard initialization response
        return {
            protocolVersion,
            capabilities: {
                tools: {},
                resources: {},
                prompts: {},
                logging: {},
            },
            serverInfo: {
                name: "desktop-commander",
                version: VERSION,
            },
            instructions: SERVER_INSTRUCTIONS,
        };
    } catch (error) {
        logToStderr('error', `Error in initialization handler: ${error}`);
        throw error;
    }
});

// Export current client info for access by other modules
export { currentClient, currentCallIsRemote, currentRemoteClient };

deferLog('info', 'Setting up request handlers...');

/**
 * Check if a tool should be included based on current client
 */
function shouldIncludeTool(toolName: string): boolean {
    // Exclude these tools for desktop-commander client (DC-specific meta-tools not useful when DC itself is the client)
    if (currentClient?.name === 'desktop-commander-app') {
        if (toolName === 'give_feedback_to_desktop_commander') {
            return false;
        }
    }

    // Add more conditional tool logic here as needed
    // Example: if (toolName === 'some_tool' && currentClient?.name === 'some_client') return false;

    return true;
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
        // logToStderr('debug', 'Generating tools list...');
        const showMcpUiPreviews = await shouldShowMcpUiPreviews();

        // Build complete tools array
        const allTools = [
            // Configuration tools
            {
                name: "get_config",
                description: `Get Desktop Commander server configuration and runtime/system information, including allowed directories, blocked commands, file limits, telemetry settings, and client information.`,
                inputSchema: zodToJsonSchema(GetConfigArgsSchema),
                _meta: buildUiToolMeta(CONFIG_EDITOR_RESOURCE_URI, true, showMcpUiPreviews),
                annotations: {
                    title: "Get Configuration",
                    readOnlyHint: true,
                    openWorldHint: false,
                    destructiveHint: false,
                },
            },
            {
                name: "set_config_value",
                description: `Set one server configuration value by key. Configuration changes can alter filesystem, command, telemetry, or runtime behavior.`,
                inputSchema: zodToJsonSchema(SetConfigValueArgsSchema),
                annotations: {
                    title: "Set Configuration Value",
                    readOnlyHint: false,
                    destructiveHint: true,
                    openWorldHint: false,
                },
            },

            // Filesystem tools
            {
                name: "read_file",
                description: `Read local files or URLs. Supports text pagination and structured handling for Excel, images, PDF, and DOCX. Filesystem reads respect allowed directories.`,
                inputSchema: zodToJsonSchema(ReadFileArgsSchema),
                _meta: buildUiToolMeta(FILE_PREVIEW_RESOURCE_URI, true, showMcpUiPreviews),
                annotations: {
                    title: "Read File or URL",
                    readOnlyHint: true,
                    openWorldHint: true,
                    destructiveHint: false,
                },
            },
            {
                name: "read_multiple_files",
                description: `Read multiple files in one call. Individual failures do not abort successful reads; supported files are returned independently.`,
                inputSchema: zodToJsonSchema(ReadMultipleFilesArgsSchema),
                annotations: {
                    title: "Read Multiple Files",
                    readOnlyHint: true,
                    openWorldHint: false,
                    destructiveHint: false,
                },
            },
            {
                name: "write_file",
                description: `Write or append file content. Supports text, Excel data, and DOCX creation from markdown. PDF creation or modification is handled by write_pdf.`,
                inputSchema: zodToJsonSchema(WriteFileArgsSchema),
                _meta: buildUiToolMeta(FILE_PREVIEW_RESOURCE_URI, true, showMcpUiPreviews),
                annotations: {
                    title: "Write File",
                    readOnlyHint: false,
                    destructiveHint: true,
                    openWorldHint: false,
                },
            },
            {
                name: "write_pdf",
                description: `Create a PDF from markdown/HTML/CSS/SVG or modify an existing PDF with page insert/delete operations.`,
                inputSchema: zodToJsonSchema(WritePdfArgsSchema),
                annotations: {
                    title: "Write/Modify PDF",
                    readOnlyHint: false,
                    destructiveHint: true,
                    openWorldHint: false,
                },
            },
            {
                name: "create_directory",
                description: `Create a directory, including missing parent directories, within allowed filesystem locations.`,
                inputSchema: zodToJsonSchema(CreateDirectoryArgsSchema),
                annotations: {
                    title: "Create Directory",
                    readOnlyHint: false,
                    openWorldHint: false,
                    destructiveHint: false,
                },
            },
            {
                name: "list_directory",
                description: `List files and directories recursively to a requested depth.`,
                inputSchema: zodToJsonSchema(ListDirectoryArgsSchema),
                _meta: buildUiToolMeta(FILE_PREVIEW_RESOURCE_URI, true, showMcpUiPreviews),
                annotations: {
                    title: "List Directory Contents",
                    readOnlyHint: true,
                    openWorldHint: false,
                    destructiveHint: false,
                },
            },
            {
                name: "move_file",
                description: `Move or rename a file or directory between allowed filesystem locations.`,
                inputSchema: zodToJsonSchema(MoveFileArgsSchema),
                annotations: {
                    title: "Move/Rename File",
                    readOnlyHint: false,
                    destructiveHint: true,
                    openWorldHint: false,
                },
            },
            {
                name: "start_search",
                description: `Start a cancellable streaming search for file names or file contents. Results are retrieved progressively with get_more_search_results.`,
                inputSchema: zodToJsonSchema(StartSearchArgsSchema),
                annotations: {
                    title: "Start Search",
                    readOnlyHint: true,
                    openWorldHint: false,
                    destructiveHint: false,
                },
            },
            {
                name: "get_more_search_results",
                description: `Read results from a search session using offset/length pagination. Repeated calls can follow a still-running search until completion.`,
                inputSchema: zodToJsonSchema(GetMoreSearchResultsArgsSchema),
                annotations: {
                    title: "Get Search Results",
                    readOnlyHint: true,
                    openWorldHint: false,
                    destructiveHint: false,
                },
            },
            {
                name: "stop_search",
                description: `Stop an active search session when no further results are needed.`,
                inputSchema: zodToJsonSchema(StopSearchArgsSchema),
                annotations: {
                    title: "Stop Search",
                    readOnlyHint: false,
                    openWorldHint: false,
                    destructiveHint: false,
                },
            },
            {
                name: "list_searches",
                description: `List tracked search sessions with status and runtime information.`,
                inputSchema: zodToJsonSchema(ListSearchesArgsSchema),
                annotations: {
                    title: "List Active Searches",
                    readOnlyHint: true,
                    openWorldHint: false,
                    destructiveHint: false,
                },
            },
            {
                name: "get_file_info",
                description: `Get file or directory metadata such as size, timestamps, permissions, line counts, and format-specific information.`,
                inputSchema: zodToJsonSchema(GetFileInfoArgsSchema),
                annotations: {
                    title: "Get File Information",
                    readOnlyHint: true,
                    openWorldHint: false,
                    destructiveHint: false,
                },
            },
            // Note: list_allowed_directories removed - use get_config to check allowedDirectories

            // Editing tools
            {
                name: "edit_block",
                description: `Apply targeted edits without rewriting the whole file. Supports text/DOCX replacements and structured range updates such as Excel cells.`,
                inputSchema: zodToJsonSchema(EditBlockArgsSchema),
                _meta: buildUiToolMeta(FILE_PREVIEW_RESOURCE_URI, true, showMcpUiPreviews),
                annotations: {
                    title: "Edit Block",
                    readOnlyHint: false,
                    destructiveHint: true,
                    openWorldHint: false,
                },
            },

            // Terminal tools
            {
                name: "start_process",
                description: `Start a one-shot command, long-running process, shell, or interactive REPL with process-state and prompt detection.`,
                inputSchema: zodToJsonSchema(StartProcessArgsSchema),
                annotations: {
                    title: "Start Terminal Process",
                    readOnlyHint: false,
                    destructiveHint: true,
                    openWorldHint: true,
                },
            },
            {
                name: "read_process_output",
                description: `Read newly available output from a running process, with pagination and completion/waiting-state detection.`,
                inputSchema: zodToJsonSchema(ReadProcessOutputArgsSchema),
                annotations: {
                    title: "Read Process Output",
                    readOnlyHint: true,
                    openWorldHint: false,
                    destructiveHint: false,
                },
            },
            {
                name: "interact_with_process",
                description: `Send input to a running shell, REPL, or other interactive process and return newly available output.`,
                inputSchema: zodToJsonSchema(InteractWithProcessArgsSchema),
                annotations: {
                    title: "Send Input to Process",
                    readOnlyHint: false,
                    destructiveHint: true,
                    openWorldHint: true,
                },
            },
            {
                name: "force_terminate",
                description: `Force-terminate a terminal session tracked by Desktop Commander.`,
                inputSchema: zodToJsonSchema(ForceTerminateArgsSchema),
                annotations: {
                    title: "Force Terminate Process",
                    readOnlyHint: false,
                    destructiveHint: true,
                    openWorldHint: false,
                },
            },
            {
                name: "list_sessions",
                description: `List Desktop Commander terminal sessions with process ID, state, and runtime information.`,
                inputSchema: zodToJsonSchema(ListSessionsArgsSchema),
                annotations: {
                    title: "List Terminal Sessions",
                    readOnlyHint: true,
                    openWorldHint: false,
                    destructiveHint: false,
                },
            },
            {
                name: "list_processes",
                description: `List operating-system processes with PID, command name, CPU usage, and memory usage.`,
                inputSchema: zodToJsonSchema(ListProcessesArgsSchema),
                annotations: {
                    title: "List Running Processes",
                    readOnlyHint: true,
                    openWorldHint: false,
                    destructiveHint: false,
                },
            },
            {
                name: "kill_process",
                description: `Terminate an operating-system process by positive PID.`,
                inputSchema: zodToJsonSchema(KillProcessArgsSchema),
                annotations: {
                    title: "Kill Process",
                    readOnlyHint: false,
                    destructiveHint: true,
                    openWorldHint: false,
                },
            },
            {
                name: "get_usage_stats",
                description: `Get Desktop Commander tool-usage and performance statistics for diagnostics.`,
                inputSchema: zodToJsonSchema(GetUsageStatsArgsSchema),
                annotations: {
                    title: "Get Usage Statistics",
                    readOnlyHint: true,
                    openWorldHint: false,
                    destructiveHint: false,
                },
            },
            {
                name: "get_recent_tool_calls",
                description: `Get recent Desktop Commander tool-call history for diagnostics or context recovery.`,
                inputSchema: zodToJsonSchema(GetRecentToolCallsArgsSchema),
                annotations: {
                    title: "Get Recent Tool Calls",
                    readOnlyHint: true,
                    openWorldHint: false,
                    destructiveHint: false,
                },
            },
            {
                name: "give_feedback_to_desktop_commander",
                description: `Open the Desktop Commander feedback form in the browser.`,
                inputSchema: zodToJsonSchema(GiveFeedbackArgsSchema),
                annotations: {
                    title: "Give Feedback",
                    readOnlyHint: false,
                    openWorldHint: true,
                    destructiveHint: false,
                },
            },
        ];

        // Filter tools based on current client
        const filteredTools = allTools.filter(tool => shouldIncludeTool(tool.name));

        // logToStderr('debug', `Returning ${filteredTools.length} tools (filtered from ${allTools.length} total) for client: ${currentClient?.name || 'unknown'}`);

        return {
            tools: filteredTools,
        };
    } catch (error) {
        logToStderr('error', `Error in list_tools request handler: ${error}`);
        throw error;
    }
});

import * as handlers from './handlers/index.js';
import { ServerResult } from './types.js';
import { withoutInternalFacts } from './utils/internal-facts.js';
import { stillLoadingError, type FileAction } from './utils/files/index.js';

/**
 * A tool call on an Excel, DOCX or PDF file whose package is still loading
 * after initialize answers at once with this error (utils/files/factory.ts)
 * instead of loading it inside the call. Not sent to telemetry, unlike other
 * errors: it names the file. read_multiple_files answers per file;
 * get_file_info waits for the load, or loads it itself, and so does a search.
 */
function stillLoading(filePath: unknown, action: FileAction, options?: { isPdf?: boolean; isUrl?: boolean }): ServerResult | undefined {
    const error = typeof filePath === 'string' ? stillLoadingError(filePath, action, options) : undefined;
    return error === undefined ? undefined : { content: [{ type: 'text', text: `Error: ${error}` }], isError: true };
}

server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest): Promise<ServerResult> => {
    const args = request.params.arguments;
    // Calls fired programmatically by the widget UIs (file preview, config
    // editor) carry origin:'ui'. They are real tool executions but not agent
    // actions, so they must produce zero telemetry: running them inside the
    // UI-origin capture context makes capture() drop every event they raise
    // (server_call_tool, server_read_file, server_edit_block, ...). Deliberate
    // UI interactions are tracked separately via mcp_ui_event.
    const isUiOriginCall = !!(args && typeof args === 'object' && (args as any).origin === 'ui');
    // Each call keeps the paths it works on, starting with its path arguments,
    // so telemetry can replace them whole in any error text the call produces
    return runWithToolCallPaths(() => {
        addToolCallPaths(...pathArguments(args));
        if (isUiOriginCall) {
            return runInUiOriginCallContext(() => handleCallToolRequest(request));
        }
        return handleCallToolRequest(request);
    });
});

/** The values of the tool arguments that hold paths (path, paths, file_path, outputPath, source, destination, shell, ...). */
function pathArguments(args: unknown): unknown[] {
    if (!args || typeof args !== 'object') return [];
    return Object.entries(args)
        .filter(([key]) => /path/i.test(key) || key === 'source' || key === 'destination' || key === 'shell')
        .map(([, value]) => value);
}

async function handleCallToolRequest(request: CallToolRequest): Promise<ServerResult> {
    const { name, arguments: args } = request.params;
    const startTime = Date.now();
    // Hoisted above the try so the finally block can read them when emitting the
    // server_call_tool completion event (duration + status), even on the crash path.
    let telemetryData: any = { tool_name: name };
    let result: ServerResult;
    let isError = false;

    try {
        // telemetryData declared above; extract metadata from _meta field if present
        const metadata = request.params._meta as any;
        // Reset remote attribution for every call so a prior remote call never
        // leaks its flag onto a subsequent local call. Set to true only when
        // this call carries the remote marker in _meta.
        const isRemoteCall = !!(metadata && typeof metadata === 'object' && metadata.remote);
        setCurrentCallIsRemote(isRemoteCall);
        if (isRemoteCall) {
            // add remote flag (convert to string for telemetry)
            telemetryData.remote = String(metadata.remote);
            // Remote calls carry the originating MCP client (e.g. openai-mcp,
            // claude-ai) in _meta.clientInfo. Attribute this call to that remote
            // client — NOT the device's own currentClient. Fall back to a sentinel
            // when it's absent so the call is visibly remote-but-unattributed
            // rather than masquerading as the local device client. We deliberately
            // do NOT call updateCurrentClient here: currentClient tracks the LOCAL
            // client and must not be polluted (nor its transport reconfigured) by
            // remote callers.
            const remoteClient =
                metadata.clientInfo && (metadata.clientInfo.name || metadata.clientInfo.version)
                    ? metadata.clientInfo
                    : { name: 'remote-unknown', version: 'unknown' };
            setCurrentRemoteClient(remoteClient);
            telemetryData.client_name = remoteClient.name;
            telemetryData.client_version = remoteClient.version;
        } else {
            // Local call — clear any remote attribution left by a prior call.
            setCurrentRemoteClient(null);
        }

        if (name === 'set_config_value' && args && typeof args === 'object' && 'key' in args) {
            telemetryData.set_config_value_key_name = (args as any).key;
        }


        // Track tool call
        trackToolCall(name, args);

        // Using a more structured approach with dedicated handlers
        // (result is declared above so the finally block can read execution status)

        switch (name) {
            // Config tools
            case "get_config":
                try {
                    result = await getConfig();
                } catch (error) {
                    capture('server_request_error', { message: `Error in get_config handler: ${error}` });
                    result = {
                        content: [{ type: "text", text: `Error: Failed to get configuration` }],
                        isError: true,
                    };
                }
                break;
            case "set_config_value":
                try {
                    result = await setConfigValue(args);
                } catch (error) {
                    capture('server_request_error', { message: `Error in set_config_value handler: ${error}` });
                    result = {
                        content: [{ type: "text", text: `Error: Failed to set configuration value` }],
                        isError: true,
                    };
                }
                break;

            case "get_usage_stats":
                try {
                    result = await getUsageStats();
                } catch (error) {
                    capture('server_request_error', { message: `Error in get_usage_stats handler: ${error}` });
                    result = {
                        content: [{ type: "text", text: `Error: Failed to get usage statistics` }],
                        isError: true,
                    };
                }
                break;

            case "get_recent_tool_calls":
                try {
                    result = await handlers.handleGetRecentToolCalls(args);
                } catch (error) {
                    capture('server_request_error', { message: `Error in get_recent_tool_calls handler: ${error}` });
                    result = {
                        content: [{ type: "text", text: `Error: Failed to get tool call history` }],
                        isError: true,
                    };
                }
                break;

            case "track_ui_event":
                try {
                    result = await handlers.handleTrackUiEvent(args);
                } catch (error) {
                    capture('server_request_error', { message: `Error in track_ui_event handler: ${error}` });
                    result = {
                        content: [{ type: "text", text: `Error: Failed to track UI event` }],
                        isError: true,
                    };
                }
                break;

            case "give_feedback_to_desktop_commander":
                try {
                    result = await giveFeedbackToDesktopCommander(args);
                } catch (error) {
                    capture('server_request_error', { message: `Error in give_feedback_to_desktop_commander handler: ${error}` });
                    result = {
                        content: [{ type: "text", text: `Error: Failed to open feedback form` }],
                        isError: true,
                    };
                }
                break;

            // Terminal tools
            case "start_process":
                result = await handlers.handleStartProcess(args);
                break;

            case "read_process_output":
                result = await handlers.handleReadProcessOutput(args);
                break;

            case "interact_with_process":
                result = await handlers.handleInteractWithProcess(args);
                break;

            case "force_terminate":
                result = await handlers.handleForceTerminate(args);
                break;

            case "list_sessions":
                result = await handlers.handleListSessions();
                break;

            // Process tools
            case "list_processes":
                result = await handlers.handleListProcesses();
                break;

            case "kill_process":
                result = await handlers.handleKillProcess(args);
                break;

            // Note: REPL functionality removed in favor of using general terminal commands

            // Filesystem tools
            case "read_file":
                result = stillLoading(args?.path, 'read', { isUrl: args?.isUrl === true }) ?? await handlers.handleReadFile(args);
                break;

            case "read_multiple_files":
                result = await handlers.handleReadMultipleFiles(args, (filePath) => stillLoadingError(filePath, 'read'));
                break;

            case "write_file":
                result = stillLoading(args?.path, 'write') ?? await handlers.handleWriteFile(args);
                break;

            case "write_pdf": {
                // Markdown (a new PDF) or page edits, read as the tool reads them;
                // arguments the tool refuses get its own error
                const parsed = WritePdfArgsSchema.safeParse(args);
                const action = parsed.success && typeof parsed.data.content === 'string' ? 'write' : 'edit';
                result = (parsed.success ? stillLoading(parsed.data.path, action, { isPdf: true }) : undefined) ?? await handlers.handleWritePdf(args);
                break;
            }

            case "create_directory":
                result = await handlers.handleCreateDirectory(args);
                break;

            case "list_directory":
                result = await handlers.handleListDirectory(args);
                break;

            case "move_file":
                result = await handlers.handleMoveFile(args);
                break;

            case "start_search":
                result = await handlers.handleStartSearch(args);
                break;

            case "get_more_search_results":
                result = await handlers.handleGetMoreSearchResults(args);
                break;

            case "stop_search":
                result = await handlers.handleStopSearch(args);
                break;

            case "list_searches":
                result = await handlers.handleListSearches();
                break;

            case "get_file_info":
                result = await handlers.handleGetFileInfo(args);
                break;

            case "edit_block":
                result = stillLoading(args?.file_path, 'edit') ?? await handlers.handleEditBlock(args);
                break;

            default:
                capture('server_unknown_tool', { name });
                result = {
                    content: [{ type: "text", text: `Error: Unknown tool: ${name}` }],
                    isError: true,
                };
        }

        // What the client receives (and the history records): facts kept internal are dropped
        result = withoutInternalFacts(name, result);

        // Add tool call to history (exclude only get_recent_tool_calls to prevent recursion)
        const duration = Date.now() - startTime;
        isError = !!result.isError;
        const EXCLUDED_TOOLS = [
            'get_recent_tool_calls',
            'track_ui_event'
        ];

        if (!EXCLUDED_TOOLS.includes(name)) {
            toolHistory.addCall(name, args, result, duration);
        }

        // Track success or failure based on result
        if (name === 'track_ui_event') {
            return result;
        }

        if (result.isError) {
            await usageTracker.trackFailure(name);
            console.log(`[FEEDBACK DEBUG] Tool ${name} failed, not checking feedback`);
        } else {
            await usageTracker.trackSuccess(name);
            console.log(`[FEEDBACK DEBUG] Tool ${name} succeeded, checking feedback...`);

            // Check if should prompt for feedback (only on successful operations)
            const shouldPrompt = await usageTracker.shouldPromptForFeedback();
            console.log(`[FEEDBACK DEBUG] Should prompt for feedback: ${shouldPrompt}`);

            if (shouldPrompt) {
                console.log(`[FEEDBACK DEBUG] Generating feedback message...`);
                const feedbackResult = await usageTracker.getFeedbackPromptMessage();
                console.log(`[FEEDBACK DEBUG] Generated variant: ${feedbackResult.variant}`);

                // Capture feedback prompt injection event
                const stats = await usageTracker.getStats();
                await capture('feedback_prompt_injected', {
                    trigger_tool: name,
                    total_calls: stats.totalToolCalls,
                    successful_calls: stats.successfulCalls,
                    failed_calls: stats.failedCalls,
                    days_since_first_use: Math.floor((Date.now() - stats.firstUsed) / (1000 * 60 * 60 * 24)),
                    total_sessions: stats.totalSessions,
                    message_variant: feedbackResult.variant
                });

                // Inject feedback instruction for the LLM
                if (result.content && result.content.length > 0 && result.content[0].type === "text") {
                    const currentContent = result.content[0].text || '';
                    result.content[0].text = `${currentContent}${feedbackResult.message}`;
                } else {
                    result.content = [
                        ...(result.content || []),
                        {
                            type: "text",
                            text: feedbackResult.message
                        }
                    ];
                }

                // Mark that we've prompted (to prevent spam)
                await usageTracker.markFeedbackPrompted();
            }

            // Check if should prompt about Docker environment
            result = await processDockerPrompt(result, name);
        }

        // If the caller sent parameters this tool does not support, Zod silently
        // strips them. Prepend a corrective warning so the model knows they were
        // ignored and which parameters are actually supported.
        try {
            const argSchema = toolArgSchemas[name];
            if (argSchema && result && Array.isArray((result as any).content)) {
                const unsupported = detectUnsupportedParams(args, argSchema);
                if (unsupported.length > 0) {
                    const warning = buildUnsupportedParamsWarning(
                        name, unsupported, getSupportedParams(argSchema)
                    );
                    (result as any).content = [
                        { type: "text", text: warning },
                        ...(result as any).content,
                    ];
                }
            }
        } catch {
            // Never let the advisory warning break an otherwise-successful call.
        }

        return result;
    } catch (error) {
        isError = true;
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Track the failure
        await usageTracker.trackFailure(name);

        capture('server_request_error', {
            error: errorMessage
        });
        return {
            content: [{ type: "text", text: `Error: ${errorMessage}` }],
            isError: true,
        };
    } finally {
        // Single tool-call telemetry event, fired AFTER execution so it can carry
        // timing. In a finally so it still fires on the hard-crash path (the catch
        // above). Only missed if a tool never returns or throws (a true hang).
        // Not emitted for track_ui_event (it is just the transport for
        // mcp_ui_event) — and UI-origin calls are dropped wholesale by the
        // capture layer, so server_call_tool reflects only genuine
        // agent-driven tool calls.
        if (name !== 'track_ui_event') {
            capture_call_tool('server_call_tool', {
                ...telemetryData,
                duration_ms: Date.now() - startTime,
                is_error: String(isError),
            });
        }
    }
}

// Add no-op handlers so Visual Studio initialization succeeds
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));