import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    ListResourcesRequestSchema,
    ListPromptsRequestSchema,
    type CallToolRequest,
} from "@modelcontextprotocol/sdk/types.js";
import {zodToJsonSchema} from "zod-to-json-schema";

// Shared constants for tool descriptions
const PATH_GUIDANCE = `IMPORTANT: Always use absolute paths (starting with '/' or drive letter like 'C:\\') for reliability. Relative paths may fail as they depend on the current working directory. Tilde paths (~/...) might not work in all contexts. Unless the user explicitly asks for relative paths, use absolute paths.`;

const CMD_PREFIX_DESCRIPTION = `This command can be referenced as "DC: ..." or "use Desktop Commander to ..." in your instructions.`;

import {
    ExecuteCommandArgsSchema,
    ReadOutputArgsSchema,
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
} from './tools/schemas.js';
import {getConfig, setConfigValue} from './tools/config.js';
import {trackToolCall} from './utils/trackTools.js';

import {VERSION} from './version.js';
import {capture} from "./utils/capture.js";

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
                        -  version (version of the DesktopCommander)
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
                        - 'length' (max lines to read, default: configurable via 'fileReadLineLimit' setting, initially 1000)
                        
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
                        Write or append to file contents with a configurable line limit per call (default: 50 lines).
                        THIS IS A STRICT REQUIREMENT. ANY file with more than the configured limit MUST BE written in chunks or IT WILL FAIL.

                        ⚠️ IMPORTANT: PREVENTATIVE CHUNKING REQUIRED in these scenarios:
                        1. When content exceeds 2,000 words or 30 lines
                        2. When writing MULTIPLE files one after another (each next file is more likely to be truncated)
                        3. When the file is the LAST ONE in a series of operations in the same message
                        
                        ALWAYS split files writes in to multiple smaller writes PREEMPTIVELY without asking the user in these scenarios.
                        
                        REQUIRED PROCESS FOR LARGE NEW FILE WRITES OR REWRITES:
                        1. FIRST → write_file(filePath, firstChunk, {mode: 'rewrite'})
                        2. THEN → write_file(filePath, secondChunk, {mode: 'append'})
                        3. THEN → write_file(filePath, thirdChunk, {mode: 'append'})
                        ... and so on for each chunk
                        
                        HANDLING TRUNCATION ("Continue" prompts):
                        If user asked to "Continue" after unfinished file write:
                        1. First, read the file to find out what content was successfully written
                        2. Identify exactly where the content was truncated
                        3. Continue writing ONLY the remaining content using {mode: 'append'}
                        4. Split the remaining content into smaller chunks (15-20 lines per chunk)
                        
                        Files over the line limit (configurable via 'fileWriteLineLimit' setting) WILL BE REJECTED if not broken into chunks as described above.
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
                    name: "execute_command",
                    description: `
                        Execute a terminal command with timeout.
                        
                        Command will continue running in background if it doesn't complete within timeout.
                        
                        NOTE: For file operations, prefer specialized tools like read_file, search_code, 
                        list_directory instead of cat, grep, or ls commands.
                        
                        ${PATH_GUIDANCE}
                        ${CMD_PREFIX_DESCRIPTION}`,
                    inputSchema: zodToJsonSchema(ExecuteCommandArgsSchema),
                },
                {
                    name: "read_output",
                    description: `
                        Read new output from a running terminal session.
                        Set timeout_ms for long running commands.
                        
                        ${CMD_PREFIX_DESCRIPTION}`,
                    inputSchema: zodToJsonSchema(ReadOutputArgsSchema),
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
    try {
        const {name, arguments: args} = request.params;
        capture('server_call_tool', {
            name
        });
        
        // Track tool call
        trackToolCall(name, args);

        // Using a more structured approach with dedicated handlers
        switch (name) {
            // Config tools
            case "get_config":
                try {
                    return await getConfig();
                } catch (error) {
                    capture('server_request_error', {message: `Error in get_config handler: ${error}`});
                    return {
                        content: [{type: "text", text: `Error: Failed to get configuration`}],
                        isError: true,
                    };
                }
            case "set_config_value":
                try {
                    return await setConfigValue(args);
                } catch (error) {
                    capture('server_request_error', {message: `Error in set_config_value handler: ${error}`});
                    return {
                        content: [{type: "text", text: `Error: Failed to set configuration value`}],
                        isError: true,
                    };
                }

            // Terminal tools
            case "execute_command":
                return await handlers.handleExecuteCommand(args);

            case "read_output":
                return await handlers.handleReadOutput(args);

            case "force_terminate":
                return await handlers.handleForceTerminate(args);

            case "list_sessions":
                return await handlers.handleListSessions();

            // Process tools
            case "list_processes":
                return await handlers.handleListProcesses();

            case "kill_process":
                return await handlers.handleKillProcess(args);

            // Filesystem tools
            case "read_file":
                return await handlers.handleReadFile(args);

            case "read_multiple_files":
                return await handlers.handleReadMultipleFiles(args);

            case "write_file":
                return await handlers.handleWriteFile(args);

            case "create_directory":
                return await handlers.handleCreateDirectory(args);

            case "list_directory":
                return await handlers.handleListDirectory(args);

            case "move_file":
                return await handlers.handleMoveFile(args);

            case "search_files":
                return await handlers.handleSearchFiles(args);

            case "search_code":
                return await handlers.handleSearchCode(args);

            case "get_file_info":
                return await handlers.handleGetFileInfo(args);

            case "edit_block":
                return await handlers.handleEditBlock(args);

            default:
                capture('server_unknown_tool', {name});
                return {
                    content: [{type: "text", text: `Error: Unknown tool: ${name}`}],
                    isError: true,
                };
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        capture('server_request_error', {
            error: errorMessage
        });
        return {
            content: [{type: "text", text: `Error: ${errorMessage}`}],
            isError: true,
        };
    }
});