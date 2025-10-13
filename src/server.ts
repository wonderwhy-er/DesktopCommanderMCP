import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    ListResourcesRequestSchema,
    ListResourceTemplatesRequestSchema,
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
    GetPromptsArgsSchema,
    GetRecentToolCallsArgsSchema,
} from './tools/schemas.js';
import {getConfig, setConfigValue} from './tools/config.js';
import {getUsageStats} from './tools/usage.js';
import {giveFeedbackToDesktopCommander} from './tools/feedback.js';
import {getPrompts} from './tools/prompts.js';
import {trackToolCall} from './utils/trackTools.js';
import {usageTracker} from './utils/usageTracker.js';
import {processDockerPrompt} from './utils/dockerPrompt.js';
import {toolHistory} from './utils/toolHistory.js';

import {VERSION} from './version.js';
import {capture, capture_call_tool} from "./utils/capture.js";
import { logToStderr, logger } from './utils/logger.js';

// Store startup messages to send after initialization
const deferredMessages: Array<{level: string, message: string}> = [];
function deferLog(level: string, message: string) {
    deferredMessages.push({level, message});
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
            // Defer client connection message until after initialization
            deferLog('info', `Client connected: ${currentClient.name} v${currentClient.version}`);
        }

        // Return standard initialization response
        return {
            protocolVersion: "2024-11-05",
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
        };
    } catch (error) {
        logToStderr('error', `Error in initialization handler: ${error}`);
        throw error;
    }
});

// Export current client info for access by other modules
export { currentClient };

deferLog('info', 'Setting up request handlers...');

/**
 * Check if a tool should be included based on current client
 */
function shouldIncludeTool(toolName: string): boolean {
    // Exclude give_feedback_to_desktop_commander for desktop-commander client
    if (toolName === 'give_feedback_to_desktop_commander' && currentClient?.name === 'desktop-commander') {
        return false;
    }

    // Add more conditional tool logic here as needed
    // Example: if (toolName === 'some_tool' && currentClient?.name === 'some_client') return false;

    return true;
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
        logToStderr('debug', 'Generating tools list...');

        // Build complete tools array
        const allTools = [
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
                    annotations: {
                        title: "Get Configuration",
                        readOnlyHint: true,
                    },
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
                    annotations: {
                        title: "Read File or URL",
                        readOnlyHint: true,
                        openWorldHint: true,
                    },
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
                    annotations: {
                        title: "Read Multiple Files",
                        readOnlyHint: true,
                    },
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
                    annotations: {
                        title: "Write File",
                        readOnlyHint: false,
                        destructiveHint: true,
                        openWorldHint: false,
                    },
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
                        
                        Supports recursive listing with the 'depth' parameter (default: 2):
                        - depth=1: Only direct contents of the directory
                        - depth=2: Contents plus one level of subdirectories
                        - depth=3+: Multiple levels deep
                        
                        CONTEXT OVERFLOW PROTECTION:
                        - Top-level directory shows ALL items
                        - Nested directories are limited to 100 items maximum per directory
                        - When a nested directory has more than 100 items, you'll see a warning like:
                          [WARNING] node_modules: 500 items hidden (showing first 100 of 600 total)
                        - This prevents overwhelming the context with large directories like node_modules
                        
                        Results show full relative paths from the root directory being listed.
                        Example output with depth=2:
                        [DIR] src
                        [FILE] src/index.ts
                        [DIR] src/tools
                        [FILE] src/tools/filesystem.ts
                        
                        If a directory cannot be accessed, it will show [DENIED] instead.
                        Only works within allowed directories.
                        
                        ${PATH_GUIDANCE}
                        ${CMD_PREFIX_DESCRIPTION}`,
                    inputSchema: zodToJsonSchema(ListDirectoryArgsSchema),
                    annotations: {
                        title: "List Directory Contents",
                        readOnlyHint: true,
                    },
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
                    annotations: {
                        title: "Move/Rename File",
                        readOnlyHint: false,
                        destructiveHint: true,
                        openWorldHint: false,
                    },
                },
                {
                    name: "start_search",
                    description: `
                        Start a streaming search that can return results progressively.
                        
                        SEARCH STRATEGY GUIDE:
                        Choose the right search type based on what the user is looking for:
                        
                        USE searchType="files" WHEN:
                        - User asks for specific files: "find package.json", "locate config files"
                        - Pattern looks like a filename: "*.js", "README.md", "test-*.tsx" 
                        - User wants to find files by name/extension: "all TypeScript files", "Python scripts"
                        - Looking for configuration/setup files: ".env", "dockerfile", "tsconfig.json"
                        
                        USE searchType="content" WHEN:
                        - User asks about code/logic: "authentication logic", "error handling", "API calls"
                        - Looking for functions/variables: "getUserData function", "useState hook"
                        - Searching for text/comments: "TODO items", "FIXME comments", "documentation"
                        - Finding patterns in code: "console.log statements", "import statements"
                        - User describes functionality: "components that handle login", "files with database queries"
                        
                        WHEN UNSURE OR USER REQUEST IS AMBIGUOUS:
                        Run TWO searches in parallel - one for files and one for content:
                        
                        Example approach for ambiguous queries like "find authentication stuff":
                        1. Start file search: searchType="files", pattern="auth"
                        2. Simultaneously start content search: searchType="content", pattern="authentication"  
                        3. Present combined results: "Found 3 auth-related files and 8 files containing authentication code"
                        
                        SEARCH TYPES:
                        - searchType="files": Find files by name (pattern matches file names)
                        - searchType="content": Search inside files for text patterns
                        
                        PATTERN MATCHING MODES:
                        - Default (literalSearch=false): Patterns are treated as regular expressions
                        - Literal (literalSearch=true): Patterns are treated as exact strings
                        
                        WHEN TO USE literalSearch=true:
                        Use literal search when searching for code patterns with special characters:
                        - Function calls with parentheses and quotes
                        - Array access with brackets
                        - Object methods with dots and parentheses
                        - File paths with backslashes
                        - Any pattern containing: . * + ? ^ $ { } [ ] | \\ ( )
                        
                        IMPORTANT PARAMETERS:
                        - pattern: What to search for (file names OR content text)
                        - literalSearch: Use exact string matching instead of regex (default: false)
                        - filePattern: Optional filter to limit search to specific file types (e.g., "*.js", "package.json")
                        - ignoreCase: Case-insensitive search (default: true). Works for both file names and content.
                        - earlyTermination: Stop search early when exact filename match is found (optional: defaults to true for file searches, false for content searches)
                        
                        DECISION EXAMPLES:
                        - "find package.json" → searchType="files", pattern="package.json" (specific file)
                        - "find authentication components" → searchType="content", pattern="authentication" (looking for functionality)
                        - "locate all React components" → searchType="files", pattern="*.tsx" or "*.jsx" (file pattern)
                        - "find TODO comments" → searchType="content", pattern="TODO" (text in files)
                        - "show me login files" → AMBIGUOUS → run both: files with "login" AND content with "login"
                        - "find config" → AMBIGUOUS → run both: config files AND files containing config code
                        
                        COMPREHENSIVE SEARCH EXAMPLES:
                        - Find package.json files: searchType="files", pattern="package.json"
                        - Find all JS files: searchType="files", pattern="*.js"
                        - Search for TODO in code: searchType="content", pattern="TODO", filePattern="*.js|*.ts"
                        - Search for exact code: searchType="content", pattern="toast.error('test')", literalSearch=true
                        - Ambiguous request "find auth stuff": Run two searches:
                          1. searchType="files", pattern="auth"
                          2. searchType="content", pattern="authentication"
                        
                        PRO TIP: When user requests are ambiguous about whether they want files or content,
                        run both searches concurrently and combine results for comprehensive coverage.
                        
                        Unlike regular search tools, this starts a background search process and returns
                        immediately with a session ID. Use get_more_search_results to get results as they
                        come in, and stop_search to stop the search early if needed.
                        
                        Perfect for large directories where you want to see results immediately and
                        have the option to cancel if the search takes too long or you find what you need.
                        
                        ${PATH_GUIDANCE}
                        ${CMD_PREFIX_DESCRIPTION}`,
                    inputSchema: zodToJsonSchema(StartSearchArgsSchema),
                },
                {
                    name: "get_more_search_results",
                    description: `
                        Get more results from an active search with offset-based pagination.
                        
                        Supports partial result reading with:
                        - 'offset' (start result index, default: 0)
                          * Positive: Start from result N (0-based indexing)
                          * Negative: Read last N results from end (tail behavior)
                        - 'length' (max results to read, default: 100)
                          * Used with positive offsets for range reading
                          * Ignored when offset is negative (reads all requested tail results)
                        
                        Examples:
                        - offset: 0, length: 100     → First 100 results
                        - offset: 200, length: 50    → Results 200-249
                        - offset: -20                → Last 20 results
                        - offset: -5, length: 10     → Last 5 results (length ignored)
                        
                        Returns only results in the specified range, along with search status.
                        Works like read_process_output - call this repeatedly to get progressive
                        results from a search started with start_search.
                        
                        ${CMD_PREFIX_DESCRIPTION}`,
                    inputSchema: zodToJsonSchema(GetMoreSearchResultsArgsSchema),
                    annotations: {
                        title: "Get Search Results",
                        readOnlyHint: true,
                    },
                },
                {
                    name: "stop_search", 
                    description: `
                        Stop an active search.
                        
                        Stops the background search process gracefully. Use this when you've found
                        what you need or if a search is taking too long. Similar to force_terminate
                        for terminal processes.
                        
                        The search will still be available for reading final results until it's
                        automatically cleaned up after 5 minutes.
                        
                        ${CMD_PREFIX_DESCRIPTION}`,
                    inputSchema: zodToJsonSchema(StopSearchArgsSchema),
                },
                {
                    name: "list_searches",
                    description: `
                        List all active searches.
                        
                        Shows search IDs, search types, patterns, status, and runtime.
                        Similar to list_sessions for terminal processes. Useful for managing
                        multiple concurrent searches.
                        
                        ${CMD_PREFIX_DESCRIPTION}`,
                    inputSchema: zodToJsonSchema(ListSearchesArgsSchema),
                    annotations: {
                        title: "List Active Searches",
                        readOnlyHint: true,
                    },
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
                    annotations: {
                        title: "Get File Information",
                        readOnlyHint: true,
                    },
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
                    annotations: {
                        title: "Edit Text Block",
                        readOnlyHint: false,
                        destructiveHint: true,
                        openWorldHint: false,
                    },
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
                        
                        BINARY FILE SUPPORT:
                        For PDF, Excel, Word, archives, databases, and other binary formats, use process tools with appropriate libraries or command-line utilities.
                        
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

                        PERFORMANCE DEBUGGING (verbose_timing parameter):
                        Set verbose_timing: true to get detailed timing information including:
                        - Exit reason (early_exit_quick_pattern, early_exit_periodic_check, process_exit, timeout)
                        - Total duration and time to first output
                        - Complete timeline of all output events with timestamps
                        - Which detection mechanism triggered early exit
                        Use this to identify missed optimization opportunities and improve detection patterns.

                        ALWAYS USE FOR: Local file analysis, CSV processing, data exploration, system commands
                        NEVER USE ANALYSIS TOOL FOR: Local file access (analysis tool is browser-only and WILL FAIL)

                        ${PATH_GUIDANCE}
                        ${CMD_PREFIX_DESCRIPTION}`,
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

                        PERFORMANCE DEBUGGING (verbose_timing parameter):
                        Set verbose_timing: true to get detailed timing information including:
                        - Exit reason (early_exit_quick_pattern, early_exit_periodic_check, process_finished, timeout)
                        - Total duration and time to first output
                        - Complete timeline of all output events with timestamps
                        - Which detection mechanism triggered early exit
                        Use this to identify when timeouts could be reduced or detection patterns improved.

                        ${CMD_PREFIX_DESCRIPTION}`,
                    inputSchema: zodToJsonSchema(ReadProcessOutputArgsSchema),
                    annotations: {
                        title: "Read Process Output",
                        readOnlyHint: true,
                    },
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
                        
                        BINARY FILE PROCESSING WORKFLOWS:
                        Use appropriate Python libraries (PyPDF2, pandas, docx2txt, etc.) or command-line tools for binary file analysis.
                        
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
                        - verbose_timing: Enable detailed performance telemetry (default: false)

                        Returns execution result with status indicators.

                        PERFORMANCE DEBUGGING (verbose_timing parameter):
                        Set verbose_timing: true to get detailed timing information including:
                        - Exit reason (early_exit_quick_pattern, early_exit_periodic_check, process_finished, timeout, no_wait)
                        - Total duration and time to first output
                        - Complete timeline of all output events with timestamps
                        - Which detection mechanism triggered early exit
                        Use this to identify slow interactions and optimize detection patterns.

                        ALWAYS USE FOR: CSV analysis, JSON processing, file statistics, data visualization prep, ANY local file work
                        NEVER USE ANALYSIS TOOL FOR: Local file access (it cannot read files from disk and WILL FAIL)

                        ${CMD_PREFIX_DESCRIPTION}`,
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
                    description: `
                        Force terminate a running terminal session.
                        
                        ${CMD_PREFIX_DESCRIPTION}`,
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
                    annotations: {
                        title: "List Terminal Sessions",
                        readOnlyHint: true,
                    },
                },
                {
                    name: "list_processes",
                    description: `
                        List all running processes.
                        
                        Returns process information including PID, command name, CPU usage, and memory usage.
                        
                        ${CMD_PREFIX_DESCRIPTION}`,
                    inputSchema: zodToJsonSchema(ListProcessesArgsSchema),
                    annotations: {
                        title: "List Running Processes",
                        readOnlyHint: true,
                    },
                },
                {
                    name: "kill_process",
                    description: `
                        Terminate a running process by PID.
                        
                        Use with caution as this will forcefully terminate the specified process.
                        
                        ${CMD_PREFIX_DESCRIPTION}`,
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
                    description: `
                        Get usage statistics for debugging and analysis.
                        
                        Returns summary of tool usage, success/failure rates, and performance metrics.
                        
                        ${CMD_PREFIX_DESCRIPTION}`,
                    inputSchema: zodToJsonSchema(GetUsageStatsArgsSchema),
                    annotations: {
                        title: "Get Usage Statistics",
                        readOnlyHint: true,
                    },
                },
                {
                    name: "get_recent_tool_calls",
                    description: `
                        Get recent tool call history with their arguments and outputs.
                        Returns chronological list of tool calls made during this session.
                        
                        Useful for:
                        - Onboarding new chats about work already done
                        - Recovering context after chat history loss
                        - Debugging tool call sequences
                        
                        Note: Does not track its own calls or other meta/query tools.
                        History kept in memory (last 1000 calls, lost on restart).
                        
                        ${CMD_PREFIX_DESCRIPTION}`,
                    inputSchema: zodToJsonSchema(GetRecentToolCallsArgsSchema),
                    annotations: {
                        title: "Get Recent Tool Calls",
                        readOnlyHint: true,
                    },
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
                {
                    name: "get_prompts",
                    description: `
                        Browse and retrieve curated Desktop Commander prompts for various tasks and workflows.
                        
                        IMPORTANT: When displaying prompt lists to users, do NOT show the internal prompt IDs (like 'onb_001'). 
                        These IDs are for your reference only. Show users only the prompt titles and descriptions.
                        The IDs will be provided in the response metadata for your use.
                        
                        DESKTOP COMMANDER INTRODUCTION: If a user asks "what is Desktop Commander?" or similar questions 
                        about what Desktop Commander can do, answer that there are example use cases and tutorials 
                        available, then call get_prompts with action='list_prompts' and category='onboarding' to show them.
                        
                        ACTIONS:
                        - list_categories: Show all available prompt categories
                        - list_prompts: List prompts (optionally filtered by category)  
                        - get_prompt: Retrieve and execute a specific prompt by ID
                        
                        WORKFLOW:
                        1. Use list_categories to see available categories
                        2. Use list_prompts to browse prompts in a category
                        3. Use get_prompt with promptId to retrieve and start using a prompt
                        
                        EXAMPLES:
                        - get_prompts(action='list_categories') - See all categories
                        - get_prompts(action='list_prompts', category='onboarding') - See onboarding prompts
                        - get_prompts(action='get_prompt', promptId='onb_001') - Get a specific prompt
                        
                        The get_prompt action will automatically inject the prompt content and begin execution.
                        Perfect for discovering proven workflows and getting started with Desktop Commander.
                        
                        ${CMD_PREFIX_DESCRIPTION}`,
                    inputSchema: zodToJsonSchema(GetPromptsArgsSchema),
                },
            ];

        // Filter tools based on current client
        const filteredTools = allTools.filter(tool => shouldIncludeTool(tool.name));

        logToStderr('debug', `Returning ${filteredTools.length} tools (filtered from ${allTools.length} total) for client: ${currentClient?.name || 'unknown'}`);

        return {
            tools: filteredTools,
        };
    } catch (error) {
        logToStderr('error', `Error in list_tools request handler: ${error}`);
        throw error;
    }
});

import * as handlers from './handlers/index.js';
import {ServerResult} from './types.js';

server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest): Promise<ServerResult> => {
    const {name, arguments: args} = request.params;
    const startTime = Date.now();

    try {
        // Prepare telemetry data - add config key for set_config_value
        const telemetryData: any = { name };
        if (name === 'set_config_value' && args && typeof args === 'object' && 'key' in args) {
            telemetryData.set_config_value_key_name = (args as any).key;
        }
        if (name === 'get_prompts' && args && typeof args === 'object') {
            const promptArgs = args as any;
            telemetryData.action = promptArgs.action;
            if (promptArgs.category) {
                telemetryData.category = promptArgs.category;
                telemetryData.has_category_filter = true;
            }
            if (promptArgs.promptId) {
                telemetryData.prompt_id = promptArgs.promptId;
            }
        }
        
        capture_call_tool('server_call_tool', telemetryData);
        
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

            case "get_prompts":
                try {
                    result = await getPrompts(args || {});
                    
                    // Capture detailed analytics for all successful get_prompts actions
                    if (args && typeof args === 'object' && !result.isError) {
                        const action = (args as any).action;
                        
                        try {
                            if (action === 'get_prompt' && (args as any).promptId) {
                                // Existing get_prompt analytics
                                const { loadPromptsData } = await import('./tools/prompts.js');
                                const promptsData = await loadPromptsData();
                                const prompt = promptsData.prompts.find(p => p.id === (args as any).promptId);
                                if (prompt) {
                                    await capture('server_get_prompt', {
                                        prompt_id: prompt.id,
                                        prompt_title: prompt.title,
                                        category: prompt.categories[0] || 'uncategorized',
                                        author: prompt.author,
                                        verified: prompt.verified
                                    });
                                }
                            } else if (action === 'list_categories') {
                                // New analytics for category browsing
                                const { loadPromptsData } = await import('./tools/prompts.js');
                                const promptsData = await loadPromptsData();
                                
                                // Extract unique categories and count prompts in each
                                const categoryMap = new Map<string, number>();
                                promptsData.prompts.forEach(prompt => {
                                    prompt.categories.forEach(category => {
                                        categoryMap.set(category, (categoryMap.get(category) || 0) + 1);
                                    });
                                });
                                
                                await capture('server_list_prompt_categories', {
                                    total_categories: categoryMap.size,
                                    total_prompts: promptsData.prompts.length,
                                    categories_available: Array.from(categoryMap.keys())
                                });
                            } else if (action === 'list_prompts') {
                                // New analytics for prompt list browsing
                                const { loadPromptsData } = await import('./tools/prompts.js');
                                const promptsData = await loadPromptsData();
                                
                                const category = (args as any).category;
                                let filteredPrompts = promptsData.prompts;
                                
                                if (category) {
                                    filteredPrompts = promptsData.prompts.filter(prompt => 
                                        prompt.categories.includes(category)
                                    );
                                }
                                
                                await capture('server_list_category_prompts', {
                                    category_filter: category || 'all',
                                    has_category_filter: !!category,
                                    prompts_shown: filteredPrompts.length,
                                    total_prompts_available: promptsData.prompts.length,
                                    prompt_ids_shown: filteredPrompts.map(p => p.id)
                                });
                            }
                        } catch (error) {
                            // Don't fail the request if analytics fail
                        }
                    }
                    
                    // Track if user used get_prompts after seeing onboarding invitation (for state management only)
                    const onboardingState = await usageTracker.getOnboardingState();
                    if (onboardingState.attemptsShown > 0 && !onboardingState.promptsUsed) {
                        // Mark that they used prompts after seeing onboarding (stops future onboarding messages)
                        await usageTracker.markOnboardingPromptsUsed();
                    }
                } catch (error) {
                    capture('server_request_error', {message: `Error in get_prompts handler: ${error}`});
                    result = {
                        content: [{type: "text", text: `Error: Failed to retrieve prompts`}],
                        isError: true,
                    };
                }
                break;

            case "get_recent_tool_calls":
                try {
                    result = await handlers.handleGetRecentToolCalls(args);
                } catch (error) {
                    capture('server_request_error', {message: `Error in get_recent_tool_calls handler: ${error}`});
                    result = {
                        content: [{type: "text", text: `Error: Failed to get tool call history`}],
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
                result = await handlers.handleEditBlock(args);
                break;

            default:
                capture('server_unknown_tool', {name});
                result = {
                    content: [{type: "text", text: `Error: Unknown tool: ${name}`}],
                    isError: true,
                };
        }

        // Add tool call to history (exclude only get_recent_tool_calls to prevent recursion)
        const duration = Date.now() - startTime;
        const EXCLUDED_TOOLS = [
            'get_recent_tool_calls'
        ];
        
        if (!EXCLUDED_TOOLS.includes(name)) {
            toolHistory.addCall(name, args, result, duration);
        }

        // Track success or failure based on result
        if (result.isError) {
            await usageTracker.trackFailure(name);
            console.log(`[FEEDBACK DEBUG] Tool ${name} failed, not checking feedback`);
        } else {
            await usageTracker.trackSuccess(name);
            console.log(`[FEEDBACK DEBUG] Tool ${name} succeeded, checking feedback...`);

            // Check if should show onboarding (before feedback - first-time users are priority)
            const shouldShowOnboarding = await usageTracker.shouldShowOnboarding();
            console.log(`[ONBOARDING DEBUG] Should show onboarding: ${shouldShowOnboarding}`);

            if (shouldShowOnboarding) {
                console.log(`[ONBOARDING DEBUG] Generating onboarding message...`);
                const onboardingResult = await usageTracker.getOnboardingMessage();
                console.log(`[ONBOARDING DEBUG] Generated variant: ${onboardingResult.variant}`);

                // Capture onboarding prompt injection event
                const stats = await usageTracker.getStats();
                await capture('server_onboarding_shown', {
                    trigger_tool: name,
                    total_calls: stats.totalToolCalls,
                    successful_calls: stats.successfulCalls,
                    days_since_first_use: Math.floor((Date.now() - stats.firstUsed) / (1000 * 60 * 60 * 24)),
                    total_sessions: stats.totalSessions,
                    message_variant: onboardingResult.variant
                });

                // Inject onboarding message for the LLM
                if (result.content && result.content.length > 0 && result.content[0].type === "text") {
                    const currentContent = result.content[0].text || '';
                    result.content[0].text = `${currentContent}${onboardingResult.message}`;
                } else {
                    result.content = [
                        ...(result.content || []),
                        {
                            type: "text",
                            text: onboardingResult.message
                        }
                    ];
                }

                // Mark that we've shown onboarding (to prevent spam)
                await usageTracker.markOnboardingShown(onboardingResult.variant);
            }

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

// Add no-op handlers so Visual Studio initialization succeeds
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));