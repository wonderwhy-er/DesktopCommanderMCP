import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    ListResourcesRequestSchema,
    ListPromptsRequestSchema,
    type CallToolRequest,
} from "@modelcontextprotocol/sdk/types.js";
import {zodToJsonSchema} from "zod-to-json-schema";
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
    EditBlockArgsSchema,
    SearchCodeArgsSchema,
    GetConfigArgsSchema,
    SetConfigValueArgsSchema,
    ListProcessesArgsSchema,
} from './tools/schemas.js';
import {getConfig, setConfigValue} from './tools/config.js';

import {VERSION} from './version.js';
import {capture} from "./utils.js";

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
                    description:
                        "Get the complete server configuration as JSON. Config includes fields for: blockedCommands (array of blocked shell commands), defaultShell (shell to use for commands), allowedDirectories (paths the server can access).",
                    inputSchema: zodToJsonSchema(GetConfigArgsSchema),
                },
                {
                    name: "set_config_value",
                    description:
                        "Set a specific configuration value by key. WARNING: Should be used in a separate chat from file operations and command execution to prevent security issues. Config keys include: blockedCommands (array), defaultShell (string), allowedDirectories (array of paths). IMPORTANT: Setting allowedDirectories to an empty array ([]) allows full access to the entire file system, regardless of the operating system.",
                    inputSchema: zodToJsonSchema(SetConfigValueArgsSchema),
                },

                // Terminal tools
                {
                    name: "execute_command",
                    description:
                        "Execute a terminal command with timeout. Command will continue running in background if it doesn't complete within timeout.",
                    inputSchema: zodToJsonSchema(ExecuteCommandArgsSchema),
                },
                {
                    name: "read_output",
                    description: "Read new output from a running terminal session.",
                    inputSchema: zodToJsonSchema(ReadOutputArgsSchema),
                },
                {
                    name: "force_terminate",
                    description: "Force terminate a running terminal session.",
                    inputSchema: zodToJsonSchema(ForceTerminateArgsSchema),
                },
                {
                    name: "list_sessions",
                    description: "List all active terminal sessions.",
                    inputSchema: zodToJsonSchema(ListSessionsArgsSchema),
                },
                {
                    name: "list_processes",
                    description: "List all running processes. Returns process information including PID, command name, CPU usage, and memory usage.",
                    inputSchema: zodToJsonSchema(ListProcessesArgsSchema),
                },
                {
                    name: "kill_process",
                    description: "Terminate a running process by PID. Use with caution as this will forcefully terminate the specified process.",
                    inputSchema: zodToJsonSchema(KillProcessArgsSchema),
                },

                // Filesystem tools
                {
                    name: "read_file",
                    description:
                        "Read the complete contents of a file from the file system or a URL. When reading from the file system, only works within allowed directories. Can fetch content from URLs when isUrl parameter is set to true. Handles text files normally and image files are returned as viewable images. Recognized image types: PNG, JPEG, GIF, WebP.",
                    inputSchema: zodToJsonSchema(ReadFileArgsSchema),
                },
                {
                    name: "read_multiple_files",
                    description:
                        "Read the contents of multiple files simultaneously. Each file's content is returned with its path as a reference. Handles text files normally and renders images as viewable content. Recognized image types: PNG, JPEG, GIF, WebP. Failed reads for individual files won't stop the entire operation. Only works within allowed directories.",
                    inputSchema: zodToJsonSchema(ReadMultipleFilesArgsSchema),
                },
                {
                    name: "write_file",
                    description:
                        "Completely replace file contents. Best for large changes (>20% of file) or when edit_block fails. Use with caution as it will overwrite existing files. Only works within allowed directories.",
                    inputSchema: zodToJsonSchema(WriteFileArgsSchema),
                },
                {
                    name: "create_directory",
                    description:
                        "Create a new directory or ensure a directory exists. Can create multiple nested directories in one operation. Only works within allowed directories.",
                    inputSchema: zodToJsonSchema(CreateDirectoryArgsSchema),
                },
                {
                    name: "list_directory",
                    description:
                        "Get a detailed listing of all files and directories in a specified path. Results distinguish between files and directories with [FILE] and [DIR] prefixes. Only works within allowed directories.",
                    inputSchema: zodToJsonSchema(ListDirectoryArgsSchema),
                },
                {
                    name: "move_file",
                    description:
                        "Move or rename files and directories. Can move files between directories and rename them in a single operation. Both source and destination must be within allowed directories.",
                    inputSchema: zodToJsonSchema(MoveFileArgsSchema),
                },
                {
                    name: "search_files",
                    description:
                        "Finds files by name using a case-insensitive substring matching. Searches through all subdirectories from the starting path. Has a default timeout of 30 seconds which can be customized using the timeoutMs parameter. Only searches within allowed directories.",
                    inputSchema: zodToJsonSchema(SearchFilesArgsSchema),
                },
                {
                    name: "search_code",
                    description:
                        "Search for text/code patterns within file contents using ripgrep. Fast and powerful search similar to VS Code search functionality. Supports regular expressions, file pattern filtering, and context lines. Has a default timeout of 30 seconds which can be customized. Only searches within allowed directories.",
                    inputSchema: zodToJsonSchema(SearchCodeArgsSchema),
                },
                {
                    name: "get_file_info",
                    description:
                        "Retrieve detailed metadata about a file or directory including size, creation time, last modified time, permissions, and type. Only works within allowed directories.",
                    inputSchema: zodToJsonSchema(GetFileInfoArgsSchema),
                },
                // Note: list_allowed_directories removed - use get_config to check allowedDirectories

                // Text editing tools
                {
                    name: "edit_block",
                    description:
                        "Apply surgical text replacements to files. Best for small changes (<20% of file size). Call repeatedly to change multiple blocks. Will verify changes after application. Format:\nfilepath\n<<<<<<< SEARCH\ncontent to find\n=======\nnew content\n>>>>>>> REPLACE",
                    inputSchema: zodToJsonSchema(EditBlockArgsSchema),
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