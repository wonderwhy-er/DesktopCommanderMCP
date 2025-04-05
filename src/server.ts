import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListPromptsRequestSchema,
  type CallToolRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { commandManager } from './command-manager.js';
import {
  ExecuteCommandArgsSchema,
  ReadOutputArgsSchema,
  ForceTerminateArgsSchema,
  ListSessionsArgsSchema,
  KillProcessArgsSchema,
  BlockCommandArgsSchema,
  UnblockCommandArgsSchema,
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
} from './tools/schemas.js';
import { executeCommand, readOutput, forceTerminate, listSessions } from './tools/execute.js';
import { listProcesses, killProcess } from './tools/process.js';
import {
  readFile,
  readMultipleFiles,
  writeFile,
  createDirectory,
  listDirectory,
  moveFile,
  searchFiles,
  getFileInfo,
  listAllowedDirectories,
  type FileResult,
} from './tools/filesystem.js';
import { parseEditBlock, performSearchReplace } from './tools/edit.js';
import { searchTextInFiles } from './tools/search.js';

import { VERSION } from './version.js';
import { capture } from "./utils.js";

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

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      // Terminal tools
      {
        name: "execute_command",
        description:
          "Execute a terminal command with timeout. Command will continue running in background if it doesn't complete within timeout.",
        inputSchema: zodToJsonSchema(ExecuteCommandArgsSchema),
      },
      {
        name: "read_output",
        description:
          "Read new output from a running terminal session.",
        inputSchema: zodToJsonSchema(ReadOutputArgsSchema),
      },
      {
        name: "force_terminate",
        description:
          "Force terminate a running terminal session.",
        inputSchema: zodToJsonSchema(ForceTerminateArgsSchema),
      },
      {
        name: "list_sessions",
        description:
          "List all active terminal sessions.",
        inputSchema: zodToJsonSchema(ListSessionsArgsSchema),
      },
      {
        name: "list_processes",
        description:
          "List all running processes. Returns process information including PID, " +
          "command name, CPU usage, and memory usage.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "kill_process",
        description:
          "Terminate a running process by PID. Use with caution as this will " +
          "forcefully terminate the specified process.",
        inputSchema: zodToJsonSchema(KillProcessArgsSchema),
      },
      {
        name: "block_command",
        description:
          "Add a command to the blacklist. Once blocked, the command cannot be executed until unblocked.",
        inputSchema: zodToJsonSchema(BlockCommandArgsSchema),
      },
      {
        name: "unblock_command",
        description:
          "Remove a command from the blacklist. Once unblocked, the command can be executed normally.",
        inputSchema: zodToJsonSchema(UnblockCommandArgsSchema),
      },
      {
        name: "list_blocked_commands",
        description:
          "List all currently blocked commands.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      // Filesystem tools
      {
        name: "read_file",
        description:
          "Read the complete contents of a file from the file system. " +
          "Handles text files normally and image files are returned as viewable images. " +
          "Recognized image types: PNG, JPEG, GIF, WebP. " +
          "Only works within allowed directories.",
        inputSchema: zodToJsonSchema(ReadFileArgsSchema),
      },
      {
        name: "read_multiple_files",
        description:
          "Read the contents of multiple files simultaneously. " +
          "Each file's content is returned with its path as a reference. " +
          "Handles text files normally and renders images as viewable content. " +
          "Recognized image types: PNG, JPEG, GIF, WebP. " +
          "Failed reads for individual files won't stop the entire operation. " +
          "Only works within allowed directories.",
        inputSchema: zodToJsonSchema(ReadMultipleFilesArgsSchema),
      },
      {
        name: "write_file",
        description:
          "Completely replace file contents. Best for large changes (>20% of file) or when edit_block fails. " +
          "Use with caution as it will overwrite existing files. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(WriteFileArgsSchema),
      },
      {
        name: "create_directory",
        description:
          "Create a new directory or ensure a directory exists. Can create multiple " +
          "nested directories in one operation. Only works within allowed directories.",
        inputSchema: zodToJsonSchema(CreateDirectoryArgsSchema),
      },
      {
        name: "list_directory",
        description:
          "Get a detailed listing of all files and directories in a specified path. " +
          "Results distinguish between files and directories with [FILE] and [DIR] prefixes. " +
          "Only works within allowed directories.",
        inputSchema: zodToJsonSchema(ListDirectoryArgsSchema),
      },
      {
        name: "move_file",
        description:
          "Move or rename files and directories. Can move files between directories " +
          "and rename them in a single operation. Both source and destination must be " +
          "within allowed directories.",
        inputSchema: zodToJsonSchema(MoveFileArgsSchema),
      },
      {
        name: "search_files",
        description:
          "Finds files by name using a case-insensitive substring matching. " +
          "Searches through all subdirectories from the starting path. " +
          "Only searches within allowed directories.",
        inputSchema: zodToJsonSchema(SearchFilesArgsSchema),
      },
      {
        name: "search_code",
        description:
          "Search for text/code patterns within file contents using ripgrep. " +
          "Fast and powerful search similar to VS Code search functionality. " +
          "Supports regular expressions, file pattern filtering, and context lines. " +
          "Only searches within allowed directories.",
        inputSchema: zodToJsonSchema(SearchCodeArgsSchema),
      },
      {
        name: "get_file_info",
        description:
          "Retrieve detailed metadata about a file or directory including size, " +
          "creation time, last modified time, permissions, and type. " +
          "Only works within allowed directories.",
        inputSchema: zodToJsonSchema(GetFileInfoArgsSchema),
      },
      {
        name: "list_allowed_directories",
        description: 
          "Returns the list of directories that this server is allowed to access.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "edit_block",
        description:
            "Apply surgical text replacements to files. Best for small changes (<20% of file size). " +
            "Call repeatedly to change multiple blocks. Will verify changes after application. " +
            "Format:\nfilepath\n<<<<<<< SEARCH\ncontent to find\n=======\nnew content\n>>>>>>> REPLACE",
        inputSchema: zodToJsonSchema(EditBlockArgsSchema),
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
  try {
    const { name, arguments: args } = request.params;
    capture('server_call_tool');
    switch (name) {
      // Terminal tools
      case "execute_command": {
        capture('server_execute_command');
        const parsed = ExecuteCommandArgsSchema.parse(args);
        return executeCommand(parsed);
      }
      case "read_output": {
        capture('server_read_output');
        const parsed = ReadOutputArgsSchema.parse(args);
        return readOutput(parsed);
      }
      case "force_terminate": {
        capture('server_force_terminate');
        const parsed = ForceTerminateArgsSchema.parse(args);
        return forceTerminate(parsed);
      }
      case "list_sessions":
        capture('server_list_sessions');
        return listSessions();
      case "list_processes":
        capture('server_list_processes');
        return listProcesses();
      case "kill_process": {
        capture('server_kill_process');
        const parsed = KillProcessArgsSchema.parse(args);
        return killProcess(parsed);
      }
      case "block_command": {
        capture('server_block_command');
        const parsed = BlockCommandArgsSchema.parse(args);
        const blockResult = await commandManager.blockCommand(parsed.command);
        return {
          content: [{ type: "text", text: blockResult }],
        };
      }
      case "unblock_command": {
        capture('server_unblock_command');
        const parsed = UnblockCommandArgsSchema.parse(args);
        const unblockResult = await commandManager.unblockCommand(parsed.command);
        return {
          content: [{ type: "text", text: unblockResult }],
        };
      }
      case "list_blocked_commands": {
        capture('server_list_blocked_commands');
        const blockedCommands = await commandManager.listBlockedCommands();
        return {
          content: [{ type: "text", text: blockedCommands.join('\n') }],
        };
      }
      
      // Filesystem tools
      case "edit_block": {
        capture('server_edit_block');
        try {
        const parsed = EditBlockArgsSchema.parse(args);
        const { filePath, searchReplace } = await parseEditBlock(parsed.blockContent);
            await performSearchReplace(filePath, searchReplace);
            return {
                content: [{ type: "text", text: `Successfully applied edit to ${filePath}` }],
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            capture('server_' + name + "_error");
            return {
                content: [{ type: "text", text: `Error: ${errorMessage}` }],
            }; 
        }
      }
      case "read_file": {
        capture('server_read_file');
        try {
            const parsed = ReadFileArgsSchema.parse(args);
            // Explicitly cast the result to FileResult since we're passing true
            const fileResult = await readFile(parsed.path, true) as FileResult;
            
            if (fileResult.isImage) {
                // For image files, return as an image content type
                return {
                    content: [
                        { 
                            type: "text", 
                            text: `Image file: ${parsed.path} (${fileResult.mimeType})\n` 
                        },
                        {
                            type: "image",
                            data: fileResult.content,
                            mimeType: fileResult.mimeType
                        }
                    ],
                };
            } else {
                // For all other files, return as text
                capture('server_' + "read_file_error");
                return {
                    content: [{ type: "text", text: fileResult.content }],
                };
            }
        } catch (error) {
            capture('server_' + name + "_error");
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [{ type: "text", text: `Error: ${errorMessage}` }],
            };
        }
      }
      case "read_multiple_files": {
        capture('server_read_multiple_files');
        try {
            const parsed = ReadMultipleFilesArgsSchema.parse(args);
            const fileResults = await readMultipleFiles(parsed.paths);
            
            // Create a text summary of all files
            const textSummary = fileResults.map(result => {
                if (result.error) {
                    return `${result.path}: Error - ${result.error}`;
                } else if (result.mimeType) {
                    return `${result.path}: ${result.mimeType} ${result.isImage ? '(image)' : '(text)'}`;
                } else {
                    return `${result.path}: Unknown type`;
                }
            }).join("\n");
            
            // Create content items for each file
            const contentItems: Array<{type: string, text?: string, data?: string, mimeType?: string}> = [];
            
            // Add the text summary
            contentItems.push({ type: "text", text: textSummary });
            
            // Add each file content
            for (const result of fileResults) {
                if (!result.error && result.content !== undefined) {
                    if (result.isImage && result.mimeType) {
                        // For image files, add an image content item
                        contentItems.push({
                            type: "image",
                            data: result.content,
                            mimeType: result.mimeType
                        });
                    } else {
                        // For text files, add a text summary
                        contentItems.push({
                            type: "text",
                            text: `\n--- ${result.path} contents: ---\n${result.content}`
                        });
                    }
                }
            }
            
            return { content: contentItems };
        } catch (error) {
            capture('server_' + name + "_error");
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [{ type: "text", text: `Error: ${errorMessage}` }],
            };
        }
      }
      case "write_file": {
        capture('server_write_file');
        try {
            const parsed = WriteFileArgsSchema.parse(args);
            await writeFile(parsed.path, parsed.content);
            return {
                content: [{ type: "text", text: `Successfully wrote to ${parsed.path}` }],
            };
        } catch (error) {
            capture('server_' + name + "_error");
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [{ type: "text", text: `Error: ${errorMessage}` }],
            };
        }
      }
      case "create_directory": {
        capture('server_create_directory');
        try {
            const parsed = CreateDirectoryArgsSchema.parse(args);
            await createDirectory(parsed.path);
            return {
                content: [{ type: "text", text: `Successfully created directory ${parsed.path}` }],
            };
        } catch (error) {
            capture('server_' + name + "_error");
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [{ type: "text", text: `Error: ${errorMessage}` }],
            };
        }
      }
      case "list_directory": {
        capture('server_list_directory');
        try {
            const parsed = ListDirectoryArgsSchema.parse(args);
            const entries = await listDirectory(parsed.path);
            return {
                content: [{ type: "text", text: entries.join('\n') }],
            };
        } catch (error) {
            capture('server_' + name + "_error");
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [{ type: "text", text: `Error: ${errorMessage}` }],
            };
        }
      }
      case "move_file": {
        capture('server_move_file');
        try {
            const parsed = MoveFileArgsSchema.parse(args);
            await moveFile(parsed.source, parsed.destination);
            return {
                content: [{ type: "text", text: `Successfully moved ${parsed.source} to ${parsed.destination}` }],
            };
        } catch (error) {
            capture('server_' + name + "_error");
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [{ type: "text", text: `Error: ${errorMessage}` }],
            };
        }
      }
      case "search_files": {
        capture('server_search_files');
        try {
            const parsed = SearchFilesArgsSchema.parse(args);
            const results = await searchFiles(parsed.path, parsed.pattern);
            return {
                content: [{ type: "text", text: results.length > 0 ? results.join('\n') : "No matches found" }],
            };
        } catch (error) {
            capture('server_' + name + "_error");
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [{ type: "text", text: `Error: ${errorMessage}` }],
            };
        }
      }
      case "search_code": {
        capture('server_search_code');
        let results = [];
        try {
            const parsed = SearchCodeArgsSchema.parse(args);
            results = await searchTextInFiles({
                rootPath: parsed.path,
                pattern: parsed.pattern,
                filePattern: parsed.filePattern,
                ignoreCase: parsed.ignoreCase,
                maxResults: parsed.maxResults,
                includeHidden: parsed.includeHidden,
                contextLines: parsed.contextLines,
            });
            if (results.length === 0) {
                return {
                    content: [{ type: "text", text: "No matches found" }],
                };
            }
        } catch (error) {
            capture('server_' + name + "_error");
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [{ type: "text", text: `Error: ${errorMessage}` }],
            };
        }

        // Format the results in a VS Code-like format
        let currentFile = "";
        let formattedResults = "";

        results.forEach(result => {
          if (result.file !== currentFile) {
            formattedResults += `\n${result.file}:\n`;
            currentFile = result.file;
          }
          formattedResults += `  ${result.line}: ${result.match}\n`;
        });

        return {
          content: [{ type: "text", text: formattedResults.trim() }],
        };
      }
      case "get_file_info": {
        capture('server_get_file_info');
        try {
            const parsed = GetFileInfoArgsSchema.parse(args);
            const info = await getFileInfo(parsed.path);
            return {
            content: [{ 
                type: "text", 
                text: Object.entries(info)
                .map(([key, value]) => `${key}: ${value}`)
                .join('\n') 
            }],
            };
        } catch (error) {
            capture('server_' + name + "_error");
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [{ type: "text", text: `Error: ${errorMessage}` }],
            };
        }
      }
      case "list_allowed_directories": {
        capture('server_list_allowed_directories');
        const directories = listAllowedDirectories();
        return {
          content: [{ 
            type: "text", 
            text: `Allowed directories:\n${directories.join('\n')}` 
          }],
        };
      }

      default:
        capture('server_unknow_tool', {
            name
        });
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    capture('server_request_error', {
        error: errorMessage
    });
    return {
      content: [{ type: "text", text: `Error: ${errorMessage}` }],
      isError: true,
    };
  }
});