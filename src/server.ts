import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    ListResourcesRequestSchema,
    ListPromptsRequestSchema,
    InitializeRequestSchema,
    type CallToolRequest,
    type InitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import {zodToJsonSchema} from "zod-to-json-schema";
import { getSystemInfo, getOSSpecificGuidance, getPathGuidance, getDevelopmentToolGuidance } from './utils/system-info.js';

// Get system information once at startup
const SYSTEM_INFO = getSystemInfo();
const OS_GUIDANCE = getOSSpecificGuidance(SYSTEM_INFO);
const DEV_TOOL_GUIDANCE = getDevelopmentToolGuidance(SYSTEM_INFO);
const PATH_GUIDANCE = `IMPORTANT: ${getPathGuidance(SYSTEM_INFO)} Relative paths may fail as they depend on the current working directory. Tilde paths (~/...) might not work in all contexts. Unless the user explicitly asks for relative paths, use absolute paths.`;

const CMD_PREFIX_DESCRIPTION = `This command can be referenced as "DC: ..." or "use Desktop Commander to ..." in your instructions.`;

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
    SearchFilesArgsSchema,
    GetFileInfoArgsSchema,
    SearchCodeArgsSchema,
    GetConfigArgsSchema,
    SetConfigValueArgsSchema,
    ListProcessesArgsSchema,
    EditBlockArgsSchema,
    GetUsageStatsArgsSchema,
    GiveFeedbackArgsSchema,
} from './tools/schemas.js';
import {getConfig, setConfigValue} from './tools/config.js';
import {getUsageStats} from './tools/usage.js';
import {giveFeedbackToDesktopCommander} from './tools/feedback.js';
import {trackToolCall} from './utils/trackTools.js';
import {usageTracker} from './utils/usageTracker.js';

import {VERSION} from './version.js';
import {capture, capture_call_tool} from "./utils/capture.js";

console.error("Loading server.ts");

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
        },
    },
);

// Add handler for resources/list method
server.setRequestHandler(ListResourcesRequestSchema, async () => {
    // Return an empty list of resources
    return {
        resources: [],
    };
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

// Add handler for initialization method - capture client info
server.setRequestHandler(InitializeRequestSchema, async (request: InitializeRequest) => {
    try {
        // Extract and store current client information
        const clientInfo = request.params?.clientInfo;
        if (clientInfo) {
            currentClient = {
                name: clientInfo.name || 'unknown',
                version: clientInfo.version || 'unknown'
            };
            console.log(`Client connected: ${currentClient.name} v${currentClient.version}`);
        }

        // Return standard initialization response
        return {
            protocolVersion: "2024-11-05",
            capabilities: {
                tools: {},
                resources: {},
                prompts: {},
            },
            serverInfo: {
                name: "desktop-commander",
                version: VERSION,
            },
        };
    } catch (error) {
        console.error("Error in initialization handler:", error);
        throw error;
    }
});

// Export current client info for access by other modules
export { currentClient };

console.error("Setting up request handlers...");

server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
        console.error("Generating tools list...");
        return {
            tools: [
                // Configuration tools
                {
                    name: "get_config",
                    description: `
                        Get the complete server configuration as JSON. Config includes fields for:
                        - blockedCommands (array of blocked shell commands)
                        - defaultShell (shell to use for commands)
                        - allowedDirectories (paths the server can access)
                        - fileReadLineLimit (max lines for read_file, default 1000)
                        - fileWriteLineLimit (max lines per write_file call, default 50)
                        - telemetryEnabled (boolean for telemetry opt-in/out)
                        - currentClient (information about the currently connected MCP client)
                        - clientHistory (history of all clients that have connected)
                        - version (version of the DesktopCommander)
                        - systemInfo (operating system and environment details)
                        ${CMD_PREFIX_DESCRIPTION}`,
                    inputSchema: zodToJsonSchema(GetConfigArgsSchema),
                },
                {
                    name: "set_config_value",
                    description: `
                        Set a specific configuration value by key.
                        
                        WARNING: Should be used in a separate chat from file operations and 
                        command execution to prevent security issues.
                        
                        Config keys include:
                        - blockedCommands (array)
                        - defaultShell (string)
                        - allowedDirectories (array of paths)
                        - fileReadLineLimit (number, max lines for read_file)
                        - fileWriteLineLimit (number, max lines per write_file call)
                        - telemetryEnabled (boolean)
                        
                        IMPORTANT: Setting allowedDirectories to an empty array ([]) allows full access 
                        to the entire file system, regardless of the operating system.
                        
                        ${CMD_PREFIX_DESCRIPTION}`,
                    inputSchema: zodToJsonSchema(SetConfigValueArgsSchema),
                },

                // Filesystem tools
                {
                    name: "read_file",
                    description: `
                        Read the contents of a file from the file system or a URL with optional offset and length parameters.
                        
                        Prefer this over 'execute_command' with cat/type for viewing files.
                        
                        Supports partial file reading with:
                        - 'offset' (start line, default: 0)
                          * Positive: Start from line N (0-based indexing)
                          * Negative: Read last N lines from end (tail behavior)
                        - 'length' (max lines to read, default: configurable via 'fileReadLineLimit' setting, initially 1000)
                          * Used with positive offsets for range reading
                          * Ignored when offset is negative (reads all requested tail lines)
                        
                        Examples:
                        - offset: 0, length: 10     → First 10 lines
                        - offset: 100, length: 5    → Lines 100-104
                        - offset: -20               → Last 20 lines  
                        - offset: -5, length: 10    → Last 5 lines (length ignored)
                        
                        Performance optimizations:
                        - Large files with negative offsets use reverse reading for efficiency
                        - Large files with deep positive offsets use byte estimation
                        - Small files use fast readline streaming
                        
                        When reading from the file system, only works within allowed directories.
                        Can fetch content from URLs when isUrl parameter is set to true
                        (URLs are always read in full regardless of offset/length).
                        
                        Handles text files normally and image files are returned as viewable images.
                        Recognized image types: PNG, JPEG, GIF, WebP.
                        
                        ${PATH_GUIDANCE}
                        ${CMD_PREFIX_DESCRIPTION}`,
                    inputSchema: zodToJsonSchema(ReadFileArgsSchema),
                },
                {
                    name: "read_multiple_files",
                    description: `
                        Read the contents of multiple files simultaneously.
                        
                        Each file's content is returned with its path as a reference.
                        Handles text files normally and renders images as viewable content.
                        Recognized image types: PNG, JPEG, GIF, WebP.
                        
                        Failed reads for individual files won't stop the entire operation.
                        Only works within allowed directories.
                        
                        ${PATH_GUIDANCE}
                        ${CMD_PREFIX_DESCRIPTION}`,
                    inputSchema: zodToJsonSchema(ReadMultipleFilesArgsSchema),
                },
                {
                    name: "write_file",
                    description: `
                        Write or append to file contents. 

                        CHUNKING IS STANDARD PRACTICE: Always write files in chunks of 25-30 lines maximum.
                        This is the normal, recommended way to write files - not an emergency measure.

                        STANDARD PROCESS FOR ANY FILE:
                        1. FIRST → write_file(filePath, firstChunk, {mode: 'rewrite'})  [≤30 lines]
                        2. THEN → write_file(filePath, secondChunk, {mode: 'append'})   [≤30 lines]
                        3. CONTINUE → write_file(filePath, nextChunk, {mode: 'append'}) [≤30 lines]

                        ALWAYS CHUNK PROACTIVELY - don't wait for performance warnings!

                        WHEN TO CHUNK (always be proactive):
                        1. Any file expected to be longer than 25-30 lines
                        2. When writing multiple files in sequence
                        3. When creating documentation, code files, or configuration files
                        
                        HANDLING CONTINUATION ("Continue" prompts):
                        If user asks to "Continue" after an incomplete operation:
                        1. Read the file to see what was successfully written
                        2. Continue writing ONLY the remaining content using {mode: 'append'}
                        3. Keep chunks to 25-30 lines each
                        
                        Files over 50 lines will generate performance notes but are still written successfully.
                        Only works within allowed directories.
                        
                        ${PATH_GUIDANCE}
                        ${CMD_PREFIX_DESCRIPTION}`,
                    inputSchema: zodToJsonSchema(WriteFileArgsSchema),
                },
                {
                    name: "create_directory",
                    description: `
                        Create a new directory or ensure a directory exists.
                        
                        Can create multiple nested directories in one operation.
                        Only works within allowed directories.
                        
                        ${PATH_GUIDANCE}
                        ${CMD_PREFIX_DESCRIPTION}`,
                    inputSchema: zodToJsonSchema(CreateDirectoryArgsSchema),
                },
                {
                    name: "list_directory",
                    description: `
                        Get a detailed listing of all files and directories in a specified path.
                        
                        Use this instead of 'execute_command' with ls/dir commands.
                        Results distinguish between files and directories with [FILE] and [DIR] prefixes.
                        Only works within allowed directories.
                        
                        ${PATH_GUIDANCE}
                        ${CMD_PREFIX_DESCRIPTION}`,
                    inputSchema: zodToJsonSchema(ListDirectoryArgsSchema),
                },
                {
                    name: "move_file",
                    description: `
                        Move or rename files and directories.
                        
                        Can move files between directories and rename them in a single operation.
                        Both source and destination must be within allowed directories.
                        
                        ${PATH_GUIDANCE}
                        ${CMD_PREFIX_DESCRIPTION}`,
                    inputSchema: zodToJsonSchema(MoveFileArgsSchema),
                },
                {
                    name: "search_files",
                    description: `
                        Finds files by name using a case-insensitive substring matching.
                        
                        Use this instead of 'execute_command' with find/dir/ls for locating files.
                        Searches through all subdirectories from the starting path.
                        
                        Has a default timeout of 30 seconds which can be customized using the timeoutMs parameter.
                        Only searches within allowed directories.
                        
                        ${PATH_GUIDANCE}
                        ${CMD_PREFIX_DESCRIPTION}`,
                    inputSchema: zodToJsonSchema(SearchFilesArgsSchema),
                },
                {
                    name: "search_code",
                    description: `
                        Search for text/code patterns within file contents using ripgrep.
                        
                        Use this instead of 'execute_command' with grep/find for searching code content.
                        Fast and powerful search similar to VS Code search functionality.
                        
                        Supports regular expressions, file pattern filtering, and context lines.
                        Has a default timeout of 30 seconds which can be customized.
                        Only searches within allowed directories.
                        
                        ${PATH_GUIDANCE}
                        ${CMD_PREFIX_DESCRIPTION}`,
                    inputSchema: zodToJsonSchema(SearchCodeArgsSchema),
                },
                {
                    name: "get_file_info",
                    description: `
                        Retrieve detailed metadata about a file or directory including:
                        - size
                        - creation time
                        - last modified time 
                        - permissions
                        - type
                        - lineCount (for text files)
                        - lastLine (zero-indexed number of last line, for text files)
                        - appendPosition (line number for appending, for text files)
                        
                        Only works within allowed directories.
                        
                        ${PATH_GUIDANCE}
                        ${CMD_PREFIX_DESCRIPTION}`,
                    inputSchema: zodToJsonSchema(GetFileInfoArgsSchema),
                },
                // Note: list_allowed_directories removed - use get_config to check allowedDirectories

                // Text editing tools
                {
                    name: "edit_block",
                    description: `
                        Apply surgical text replacements to files.
                        
                        BEST PRACTICE: Make multiple small, focused edits rather than one large edit.
                        Each edit_block call should change only what needs to be changed - include just enough 
                        context to uniquely identify the text being modified.
                        
                        Takes:
                        - file_path: Path to the file to edit
                        - old_string: Text to replace
                        - new_string: Replacement text
                        - expected_replacements: Optional parameter for number of replacements
                        
                        By default, replaces only ONE occurrence of the search text.
                        To replace multiple occurrences, provide the expected_replacements parameter with
                        the exact number of matches expected.
                        
                        UNIQUENESS REQUIREMENT: When expected_replacements=1 (default), include the minimal
                        amount of context necessary (typically 1-3 lines) before and after the change point,
                        with exact whitespace and indentation.
                        
                        When editing multiple sections, make separate edit_block calls for each distinct change
                        rather than one large replacement.
                        
                        When a close but non-exact match is found, a character-level diff is shown in the format:
                        common_prefix{-removed-}{+added+}common_suffix to help you identify what's different.
                        
                        Similar to write_file, there is a configurable line limit (fileWriteLineLimit) that warns
                        if the edited file exceeds this limit. If this happens, consider breaking your edits into
                        smaller, more focused changes.
                        
                        ${PATH_GUIDANCE}
                        ${CMD_PREFIX_DESCRIPTION}`,
                    inputSchema: zodToJsonSchema(EditBlockArgsSchema),
                },
                
                // Terminal tools
                {
                    name: "start_process",
                    description: `
                        Start a new terminal process with intelligent state detection.
                        
                        PRIMARY TOOL FOR FILE ANALYSIS AND DATA PROCESSING
                        This is the ONLY correct tool for analyzing local files (CSV, JSON, logs, etc.).
                        The analysis tool CANNOT access local files and WILL FAIL - always use processes for file-based work.
                        
                        CRITICAL RULE: For ANY local file work, ALWAYS use this tool + interact_with_process, NEVER use analysis/REPL tool.
                        
                        ${OS_GUIDANCE}
                        
                        REQUIRED WORKFLOW FOR LOCAL FILES:
                        1. start_process("python3 -i") - Start Python REPL for data analysis
                        2. interact_with_process(pid, "import pandas as pd, numpy as np")
                        3. interact_with_process(pid, "df = pd.read_csv('/absolute/path/file.csv')")
                        4. interact_with_process(pid, "print(df.describe())")
                        5. Continue analysis with pandas, matplotlib, seaborn, etc.
                        
                        COMMON FILE ANALYSIS PATTERNS:
                        • start_process("python3 -i") → Python REPL for data analysis (RECOMMENDED)
                        • start_process("node -i") → Node.js for JSON processing  
                        • start_process("cut -d',' -f1 file.csv | sort | uniq -c") → Quick CSV analysis
                        • start_process("wc -l /path/file.csv") → Line counting
                        • start_process("head -10 /path/file.csv") → File preview
                        
                        INTERACTIVE PROCESSES FOR DATA ANALYSIS:
                        1. start_process("python3 -i") - Start Python REPL for data work
                        2. start_process("node -i") - Start Node.js REPL for JSON/JS
                        3. start_process("bash") - Start interactive bash shell
                        4. Use interact_with_process() to send commands
                        5. Use read_process_output() to get responses
                        
                        SMART DETECTION:
                        - Detects REPL prompts (>>>, >, $, etc.)
                        - Identifies when process is waiting for input
                        - Recognizes process completion vs timeout
                        - Early exit prevents unnecessary waiting
                        
                        STATES DETECTED:
                        Process waiting for input (shows prompt)
                        Process finished execution  
                        Process running (use read_process_output)
                        
                        ALWAYS USE FOR: Local file analysis, CSV processing, data exploration, system commands
                        NEVER USE ANALYSIS TOOL FOR: Local file access (analysis tool is browser-only and WILL FAIL)
                        
                        ${PATH_GUIDANCE}
                        ${CMD_PREFIX_DESCRIPTION}`,
                    inputSchema: zodToJsonSchema(StartProcessArgsSchema),
                },
                {
                    name: "read_process_output",
                    description: `
                        Read output from a running process with intelligent completion detection.
                        
                        Automatically detects when process is ready for more input instead of timing out.
                        
                        SMART FEATURES:
                        - Early exit when REPL shows prompt (>>>, >, etc.)
                        - Detects process completion vs still running
                        - Prevents hanging on interactive prompts
                        - Clear status messages about process state
                        
                        REPL USAGE:
                        - Stops immediately when REPL prompt detected
                        - Shows clear status: waiting for input vs finished
                        - Shorter timeouts needed due to smart detection
                        - Works with Python, Node.js, R, Julia, etc.
                        
                        DETECTION STATES:
                        Process waiting for input (ready for interact_with_process)
                        Process finished execution
                        Timeout reached (may still be running)
                        
                        ${CMD_PREFIX_DESCRIPTION}`,
                    inputSchema: zodToJsonSchema(ReadProcessOutputArgsSchema),
                },
                {
                    name: "interact_with_process", 
                    description: `
                        Send input to a running process and automatically receive the response.
                        
                        CRITICAL: THIS IS THE PRIMARY TOOL FOR ALL LOCAL FILE ANALYSIS
                        For ANY local file analysis (CSV, JSON, data processing), ALWAYS use this instead of the analysis tool.
                        The analysis tool CANNOT access local files and WILL FAIL - use processes for ALL file-based work.
                        
                        FILE ANALYSIS PRIORITY ORDER (MANDATORY):
                        1. ALWAYS FIRST: Use this tool (start_process + interact_with_process) for local data analysis
                        2. ALTERNATIVE: Use command-line tools (cut, awk, grep) for quick processing  
                        3. NEVER EVER: Use analysis tool for local file access (IT WILL FAIL)
                        
                        REQUIRED INTERACTIVE WORKFLOW FOR FILE ANALYSIS:
                        1. Start REPL: start_process("python3 -i")
                        2. Load libraries: interact_with_process(pid, "import pandas as pd, numpy as np")
                        3. Read file: interact_with_process(pid, "df = pd.read_csv('/absolute/path/file.csv')")
                        4. Analyze: interact_with_process(pid, "print(df.describe())")
                        5. Continue: interact_with_process(pid, "df.groupby('column').size()")
                        
                        SMART DETECTION:
                        - Automatically waits for REPL prompt (>>>, >, etc.)
                        - Detects errors and completion states
                        - Early exit prevents timeout delays
                        - Clean output formatting (removes prompts)
                        
                        SUPPORTED REPLs:
                        - Python: python3 -i (RECOMMENDED for data analysis)
                        - Node.js: node -i  
                        - R: R
                        - Julia: julia
                        - Shell: bash, zsh
                        - Database: mysql, postgres
                        
                        PARAMETERS:
                        - pid: Process ID from start_process
                        - input: Code/command to execute
                        - timeout_ms: Max wait (default: 8000ms)
                        - wait_for_prompt: Auto-wait for response (default: true)
                        
                        Returns execution result with status indicators.
                        
                        ALWAYS USE FOR: CSV analysis, JSON processing, file statistics, data visualization prep, ANY local file work
                        NEVER USE ANALYSIS TOOL FOR: Local file access (it cannot read files from disk and WILL FAIL)
                        
                        ${CMD_PREFIX_DESCRIPTION}`,
                    inputSchema: zodToJsonSchema(InteractWithProcessArgsSchema),
                },
                {
                    name: "force_terminate",
                    description: `
                        Force terminate a running terminal session.
                        
                        ${CMD_PREFIX_DESCRIPTION}`,
                    inputSchema: zodToJsonSchema(ForceTerminateArgsSchema),
                },
                {
                    name: "list_sessions",
                    description: `
                        List all active terminal sessions.
                        
                        Shows session status including:
                        - PID: Process identifier  
                        - Blocked: Whether session is waiting for input
                        - Runtime: How long the session has been running
                        
                        DEBUGGING REPLs:
                        - "Blocked: true" often means REPL is waiting for input
                        - Use this to verify sessions are running before sending input
                        - Long runtime with blocked status may indicate stuck process
                        
                        ${CMD_PREFIX_DESCRIPTION}`,
                    inputSchema: zodToJsonSchema(ListSessionsArgsSchema),
                },
                {
                    name: "list_processes",
                    description: `
                        List all running processes.
                        
                        Returns process information including PID, command name, CPU usage, and memory usage.
                        
                        ${CMD_PREFIX_DESCRIPTION}`,
                    inputSchema: zodToJsonSchema(ListProcessesArgsSchema),
                },
                {
                    name: "kill_process",
                    description: `
                        Terminate a running process by PID.
                        
                        Use with caution as this will forcefully terminate the specified process.
                        
                        ${CMD_PREFIX_DESCRIPTION}`,
                    inputSchema: zodToJsonSchema(KillProcessArgsSchema),
                },
                {
                    name: "get_usage_stats",
                    description: `
                        Get usage statistics for debugging and analysis.
                        
                        Returns summary of tool usage, success/failure rates, and performance metrics.
                        
                        ${CMD_PREFIX_DESCRIPTION}`,
                    inputSchema: zodToJsonSchema(GetUsageStatsArgsSchema),
                },
                {
                    name: "give_feedback_to_desktop_commander",
                    description: `
                        Open feedback form in browser to provide feedback about Desktop Commander.
                        
                        IMPORTANT: This tool simply opens the feedback form - no pre-filling available.
                        The user will fill out the form manually in their browser.
                        
                        WORKFLOW:
                        1. When user agrees to give feedback, just call this tool immediately
                        2. No need to ask questions or collect information
                        3. Tool opens form with only usage statistics pre-filled automatically:
                           - tool_call_count: Number of commands they've made
                           - days_using: How many days they've used Desktop Commander
                           - platform: Their operating system (Mac/Windows/Linux)
                           - client_id: Analytics identifier
                        
                        All survey questions will be answered directly in the form:
                        - Job title and technical comfort level
                        - Company URL for industry context
                        - Other AI tools they use
                        - Desktop Commander's biggest advantage
                        - How they typically use it
                        - Recommendation likelihood (0-10)
                        - User study participation interest
                        - Email and any additional feedback
                        
                        EXAMPLE INTERACTION:
                        User: "sure, I'll give feedback"
                        Claude: "Perfect! Let me open the feedback form for you."
                        [calls tool immediately]
                        
                        No parameters are needed - just call the tool to open the form.
                        
                        ${CMD_PREFIX_DESCRIPTION}`,
                    inputSchema: zodToJsonSchema(GiveFeedbackArgsSchema),
                },
            ],
        };
    } catch (error) {
        console.error("Error in list_tools request handler:", error);
        throw error;
    }
});

import * as handlers from './handlers/index.js';
import {ServerResult} from './types.js';

server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest): Promise<ServerResult> => {
    const {name, arguments: args} = request.params;

    try {
        capture_call_tool('server_call_tool', {
            name
        });
        
        // Track tool call
        trackToolCall(name, args);

        // Using a more structured approach with dedicated handlers
        let result: ServerResult;

        switch (name) {
            // Config tools
            case "get_config":
                try {
                    result = await getConfig();
                } catch (error) {
                    capture('server_request_error', {message: `Error in get_config handler: ${error}`});
                    result = {
                        content: [{type: "text", text: `Error: Failed to get configuration`}],
                        isError: true,
                    };
                }
                break;
            case "set_config_value":
                try {
                    result = await setConfigValue(args);
                } catch (error) {
                    capture('server_request_error', {message: `Error in set_config_value handler: ${error}`});
                    result = {
                        content: [{type: "text", text: `Error: Failed to set configuration value`}],
                        isError: true,
                    };
                }
                break;

            case "get_usage_stats":
                try {
                    result = await getUsageStats();
                } catch (error) {
                    capture('server_request_error', {message: `Error in get_usage_stats handler: ${error}`});
                    result = {
                        content: [{type: "text", text: `Error: Failed to get usage statistics`}],
                        isError: true,
                    };
                }
                break;

            case "give_feedback_to_desktop_commander":
                try {
                    result = await giveFeedbackToDesktopCommander(args);
                } catch (error) {
                    capture('server_request_error', {message: `Error in give_feedback_to_desktop_commander handler: ${error}`});
                    result = {
                        content: [{type: "text", text: `Error: Failed to open feedback form`}],
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
                result = await handlers.handleReadFile(args);
                break;

            case "read_multiple_files":
                result = await handlers.handleReadMultipleFiles(args);
                break;

            case "write_file":
                result = await handlers.handleWriteFile(args);
                break;

            case "create_directory":
                result = await handlers.handleCreateDirectory(args);
                break;

            case "list_directory":
                result = await handlers.handleListDirectory(args);
                break;

            case "move_file":
                result = await handlers.handleMoveFile(args);
                break;

            case "search_files":
                result = await handlers.handleSearchFiles(args);
                break;

            case "search_code":
                result = await handlers.handleSearchCode(args);
                break;

            case "get_file_info":
                result = await handlers.handleGetFileInfo(args);
                break;

            case "edit_block":
                result = await handlers.handleEditBlock(args);
                break;

            default:
                capture('server_unknown_tool', {name});
                result = {
                    content: [{type: "text", text: `Error: Unknown tool: ${name}`}],
                    isError: true,
                };
        }

        // Track success or failure based on result
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
        }

        return result;
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Track the failure
        await usageTracker.trackFailure(name);

        capture('server_request_error', {
            error: errorMessage
        });
        return {
            content: [{type: "text", text: `Error: ${errorMessage}`}],
            isError: true,
        };
    }
});