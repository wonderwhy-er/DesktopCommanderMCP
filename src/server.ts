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
import { z } from "zod";
import { DesktopCommanderArgsSchema } from './tools/schemas.js';

// Define types for Mode (internally we use consistent casing)
export type Mode = 'granular' | 'grouped' | 'YOLO';

// We'll normalize any user input to match these values

// Define a const enum for tool categories
const enum ToolCategory {
  FileRead = 'file_read',
  FileWrite = 'file_write',
  Terminal = 'terminal',
  ChangeBlockedCommands = 'change_blocked_commands'
}

// Define tool categories for 'grouped' mode
const ToolCategories: Record<string, ToolCategory> = {
  // Terminal tools
  "execute_command": ToolCategory.Terminal,
  "read_output": ToolCategory.Terminal,
  "force_terminate": ToolCategory.Terminal,
  "list_sessions": ToolCategory.Terminal,
  "list_processes": ToolCategory.Terminal,
  "kill_process": ToolCategory.Terminal,
  "list_blocked_commands": ToolCategory.Terminal,

  // Command blocking tools
  "block_command": ToolCategory.ChangeBlockedCommands,
  "unblock_command": ToolCategory.ChangeBlockedCommands,

  // File read tools
  "read_file": ToolCategory.FileRead,
  "read_multiple_files": ToolCategory.FileRead,
  "list_directory": ToolCategory.FileRead,
  "search_files": ToolCategory.FileRead,
  "search_code": ToolCategory.FileRead,
  "get_file_info": ToolCategory.FileRead,
  "list_allowed_directories": ToolCategory.FileRead,

  // File write tools
  "write_file": ToolCategory.FileWrite,
  "create_directory": ToolCategory.FileWrite,
  "move_file": ToolCategory.FileWrite,
  "edit_block": ToolCategory.FileWrite
};
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
} from './tools/filesystem.js';
import { parseEditBlock, performSearchReplace } from './tools/edit.js';
import { searchTextInFiles } from './tools/search.js';

import { VERSION } from './version.js';

// Define all tools with their metadata
const ALL_TOOLS_METADATA: Record<string, { description: string, schema: z.ZodType<any> }> = {
  // Terminal tools
  "execute_command": {
    description:
      "Execute a terminal command with timeout. Command will continue running in background if it doesn't complete within timeout.",
    schema: ExecuteCommandArgsSchema
  },
  "read_output": {
    description:
      "Read new output from a running terminal session.",
    schema: ReadOutputArgsSchema
  },
  "force_terminate": {
    description:
      "Force terminate a running terminal session.",
    schema: ForceTerminateArgsSchema
  },
  "list_sessions": {
    description:
      "List all active terminal sessions.",
    schema: ListSessionsArgsSchema
  },
  "list_processes": {
    description:
      "List all running processes. Returns process information including PID, " +
      "command name, CPU usage, and memory usage.",
    schema: z.object({})
  },
  "kill_process": {
    description:
      "Terminate a running process by PID. Use with caution as this will " +
      "forcefully terminate the specified process.",
    schema: KillProcessArgsSchema
  },
  "block_command": {
    description:
      "Add a command to the blacklist. Once blocked, the command cannot be executed until unblocked.",
    schema: BlockCommandArgsSchema
  },
  "unblock_command": {
    description:
      "Remove a command from the blacklist. Once unblocked, the command can be executed normally.",
    schema: UnblockCommandArgsSchema
  },
  "list_blocked_commands": {
    description:
      "List all currently blocked commands.",
    schema: z.object({})
  },

  // Filesystem tools
  "read_file": {
    description:
      "Read the complete contents of a file from the file system. " +
      "Handles various text encodings and provides detailed error messages " +
      "if the file cannot be read. Only works within allowed directories.",
    schema: ReadFileArgsSchema
  },
  "read_multiple_files": {
    description:
      "Read the contents of multiple files simultaneously. " +
      "Each file's content is returned with its path as a reference. " +
      "Failed reads for individual files won't stop the entire operation. " +
      "Only works within allowed directories.",
    schema: ReadMultipleFilesArgsSchema
  },
  "write_file": {
    description:
      "Completely replace file contents. Best for large changes (>20% of file) or when edit_block fails. " +
      "Use with caution as it will overwrite existing files. Only works within allowed directories.",
    schema: WriteFileArgsSchema
  },
  "create_directory": {
    description:
      "Create a new directory or ensure a directory exists. Can create multiple " +
      "nested directories in one operation. Only works within allowed directories.",
    schema: CreateDirectoryArgsSchema
  },
  "list_directory": {
    description:
      "Get a detailed listing of all files and directories in a specified path. " +
      "Results distinguish between files and directories with [FILE] and [DIR] prefixes. " +
      "Only works within allowed directories.",
    schema: ListDirectoryArgsSchema
  },
  "move_file": {
    description:
      "Move or rename files and directories. Can move files between directories " +
      "and rename them in a single operation. Both source and destination must be " +
      "within allowed directories.",
    schema: MoveFileArgsSchema
  },
  "search_files": {
    description:
      "Recursively search for files and directories matching a pattern. " +
      "Searches through all subdirectories from the starting path. " +
      "Only searches within allowed directories.",
    schema: SearchFilesArgsSchema
  },
  "search_code": {
    description:
      "Search for text/code patterns within file contents using ripgrep. " +
      "Fast and powerful search similar to VS Code search functionality. " +
      "Supports regular expressions, file pattern filtering, and context lines. " +
      "Only searches within allowed directories.",
    schema: SearchCodeArgsSchema
  },
  "get_file_info": {
    description:
      "Retrieve detailed metadata about a file or directory including size, " +
      "creation time, last modified time, permissions, and type. " +
      "Only works within allowed directories.",
    schema: GetFileInfoArgsSchema
  },
  "list_allowed_directories": {
    description:
      "Returns the list of directories that this server is allowed to access.",
    schema: z.object({})
  },
  "edit_block": {
    description:
      "Apply surgical text replacements to files. Best for small changes (<20% of file size). " +
      "Multiple blocks can be used for separate changes. Will verify changes after application. " +
      "Format: filepath, then <<<<<<< SEARCH, content to find, =======, new content, >>>>>>> REPLACE.",
    schema: EditBlockArgsSchema
  }
};

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
  // Define ToolDefinition interface locally
  interface ToolDefinition { name: string; description: string; inputSchema: any; [key: string]: unknown; }

  // Access the mode stored on the server instance
  const mode: Mode = (server as any).currentMode || 'granular'; // Default to granular
  let tools: ToolDefinition[] = [];
  const yoloSchemaJson = zodToJsonSchema(DesktopCommanderArgsSchema);
  const allowedSubtools = Object.keys(ALL_TOOLS_METADATA); // No auth filtering yet

  // Ensure case-insensitive mode comparison by normalizing to uppercase
  const normalizedMode = typeof mode === 'string' ? mode.toUpperCase() : mode;
  
  switch (normalizedMode) {
    case 'GRANULAR':
      tools = allowedSubtools.map(subtool => ({
        name: subtool, // Use specific tool name
        description: ALL_TOOLS_METADATA[subtool].description,
        inputSchema: zodToJsonSchema(ALL_TOOLS_METADATA[subtool].schema),
      }));
      break;

    case 'GROUPED':
      // Group tools by category
      const groupMap: Record<string, string[]> = {
        [ToolCategory.FileRead]: [],
        [ToolCategory.FileWrite]: [],
        [ToolCategory.Terminal]: [],
        [ToolCategory.ChangeBlockedCommands]: []
      };

      // Place each subtool in its category group
      allowedSubtools.forEach(subtool => {
        const category = ToolCategories[subtool];
        if (category && groupMap[category]) {
          groupMap[category].push(subtool);
        }
      });

      // Create a tool for each category that has subtools
      Object.entries(groupMap).forEach(([category, subtoolsInCategory]) => {
        if (subtoolsInCategory.length > 0) {
          // Build a description listing the subtools in this group
          const subtoolDetails = subtoolsInCategory
            .map((subtool) => `• ${subtool}: ${ALL_TOOLS_METADATA[subtool].description}`)
            .join('\n');

          tools.push({
            name: category,
            description: `Perform ${category.replace('_', ' ')} operations. Use 'subtool' parameter to specify operation.\nAvailable subtools:\n${subtoolDetails}`,
            inputSchema: yoloSchemaJson, // Use the YOLO schema
          });
        }
      });
      break;

    case 'YOLO':
      // This is the modified YOLO mode implementation - using the simpler negative check approach with enum
      const yoloSubtools: string[] = [];
      const blockedCommandSubtools: string[] = [];
      
      // Separate subtools into YOLO and blocked command categories
      allowedSubtools.forEach(subtool => {
        // All commands go to YOLO except block_command and unblock_command
        if (subtool === "block_command" || subtool === "unblock_command") {
          blockedCommandSubtools.push(subtool);
        } else {
          yoloSubtools.push(subtool);
        }
      });

      // Add YOLO command tool if there are subtools for it
      if (yoloSubtools.length > 0) {
        // Build a description listing all available YOLO subtools
        const subtoolDescriptions = yoloSubtools
          .map((subtool) => `• ${subtool}: ${ALL_TOOLS_METADATA[subtool].description}`)
          .join('\n');

        tools.push({
          name: "yolo", // Main YOLO tool name
          description: `Unified desktop command for file and terminal operations. Use 'subtool' parameter to specify operation.\nAvailable subtools:\n${subtoolDescriptions}`,
          inputSchema: yoloSchemaJson, // Use the YOLO schema
        });
      }

      // Add separate change_blocked_commands tool if there are subtools for it
      if (blockedCommandSubtools.length > 0) {
        const blockedCmdDescriptions = blockedCommandSubtools
          .map((subtool) => `• ${subtool}: ${ALL_TOOLS_METADATA[subtool].description}`)
          .join('\n');

        tools.push({
          name: ToolCategory.ChangeBlockedCommands, // Separate security-sensitive tool
          description: `Perform change blocked_commands operations. Use 'subtool' parameter to specify operation.\nAvailable subtools:\n${blockedCmdDescriptions}`,
          inputSchema: yoloSchemaJson, // Use the YOLO schema
        });
      }
      break;
  }

  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
  try {
    const { name: toolNameCalled, arguments: args } = request.params;
    let subtool: string;
    let finalArgs: any; // This will hold the correctly parsed args for the switch

    // 1. Determine Subtool and Parse Appropriately
    if (toolNameCalled === ToolCategory.FileRead ||
        toolNameCalled === ToolCategory.FileWrite ||
        toolNameCalled === ToolCategory.Terminal ||
        toolNameCalled === ToolCategory.ChangeBlockedCommands ||
        toolNameCalled === "yolo"
        ) {
      // Grouped or YOLO Mode Call
      const parsedYolo = DesktopCommanderArgsSchema.safeParse(args);
      if (!parsedYolo.success) {
        throw new Error(`Invalid arguments for ${toolNameCalled}: ${parsedYolo.error.message}`);
      }
      subtool = parsedYolo.data.subtool;
      finalArgs = parsedYolo.data; // Use the data from the YOLO parse

      // Validate subtool belongs to correct category if grouped mode
      if ([ToolCategory.FileRead, ToolCategory.FileWrite, ToolCategory.Terminal, ToolCategory.ChangeBlockedCommands].includes(toolNameCalled as any)) {
        const expectedCategory = toolNameCalled;
        const actualCategory = ToolCategories[subtool];
        if (!actualCategory) {
          throw new Error(`Subtool '${subtool}' specified for group '${toolNameCalled}' is unknown or uncategorized.`);
        }
        
        // Special case for list_blocked_commands to work with both Terminal and ChangeBlockedCommands
        if (subtool === "list_blocked_commands" &&
            (expectedCategory === ToolCategory.Terminal || expectedCategory === ToolCategory.ChangeBlockedCommands)) {
          // Allow this operation
        } else if (actualCategory !== expectedCategory) {
          throw new Error(`Subtool '${subtool}' cannot be used with the '${toolNameCalled}' group. It belongs to the '${actualCategory}' group.`);
        }
      }
      
      // For YOLO "yolo" tool, validate the subtool is neither block_command nor unblock_command
      if (toolNameCalled === "yolo" && (subtool === "block_command" || subtool === "unblock_command")) {
        throw new Error(`Subtool '${subtool}' cannot be used with the 'yolo' tool. This must be used with the 'change_blocked_commands' tool.`);
      }
      
      // For change_blocked_commands tool, ensure the subtool is either block_command, unblock_command, or silently allow list_blocked_commands
      if (toolNameCalled === ToolCategory.ChangeBlockedCommands &&
          subtool !== "block_command" &&
          subtool !== "unblock_command" &&
          subtool !== "list_blocked_commands") {
        throw new Error(`Subtool '${subtool}' cannot be used with the 'change_blocked_commands' tool.`);
      }
    } else if (ALL_TOOLS_METADATA[toolNameCalled]) {
      // Granular Mode Call
      subtool = toolNameCalled;
      const schema = ALL_TOOLS_METADATA[subtool].schema;
      const specificParseResult = schema.safeParse(args);
      if (!specificParseResult.success) {
        throw new Error(`Invalid arguments for '${subtool}': ${specificParseResult.error.message}`);
      }
      finalArgs = specificParseResult.data; // Use the data from the specific parse
    } else {
      // Tool name is not recognized in any mode
      throw new Error(`Unknown tool name: '${toolNameCalled}'`);
    }

    // 2. Main Dispatch Switch (Simplified Cases)
    switch (subtool) {
      // Terminal tools
      case "execute_command": {
        if (finalArgs.command === undefined) throw new Error("Missing 'command' for execute_command");
        return executeCommand({
          command: finalArgs.command,
          timeout_ms: finalArgs.timeout_ms
        });
      }
      case "read_output": {
        if (finalArgs.pid === undefined) throw new Error("Missing 'pid' for read_output");
        return readOutput({ pid: finalArgs.pid });
      }
      case "force_terminate": {
        if (finalArgs.pid === undefined) throw new Error("Missing 'pid' for force_terminate");
        return forceTerminate({ pid: finalArgs.pid });
      }
      case "list_sessions":
        return listSessions();
      case "list_processes":
        return listProcesses();
      case "kill_process": {
        if (finalArgs.pid === undefined) throw new Error("Missing 'pid' for kill_process");
        return killProcess({ pid: finalArgs.pid });
      }
      case "block_command": {
        if (finalArgs.command === undefined) throw new Error("Missing 'command' for block_command");
        const blockResult = await commandManager.blockCommand(finalArgs.command);
        return {
          content: [{ type: "text", text: blockResult ? "Command blocked successfully" : "Command was already blocked" }],
        };
      }
      case "unblock_command": {
        if (finalArgs.command === undefined) throw new Error("Missing 'command' for unblock_command");
        const unblockResult = await commandManager.unblockCommand(finalArgs.command);
        return {
          content: [{ type: "text", text: unblockResult ? "Command unblocked successfully" : "Command was not blocked" }],
        };
      }
      case "list_blocked_commands": {
        const blockedCommands = await commandManager.listBlockedCommands();
        return {
          content: [{ type: "text", text: blockedCommands.join('\n') }],
        };
      }
      
      // Filesystem tools
      case "edit_block": {
        if (finalArgs.blockContent === undefined) throw new Error("Missing 'blockContent' for edit_block");
        const { filePath, searchReplace } = await parseEditBlock(finalArgs.blockContent);
        await performSearchReplace(filePath, searchReplace);
        return {
          content: [{ type: "text", text: `Successfully applied edit to ${filePath}` }],
        };
      }
      case "read_file": {
        if (finalArgs.path === undefined) throw new Error("Missing 'path' for read_file");
        const content = await readFile(finalArgs.path);
        return {
          content: [{ type: "text", text: content }],
        };
      }
      case "read_multiple_files": {
        if (finalArgs.paths === undefined) throw new Error("Missing 'paths' for read_multiple_files");
        const results = await readMultipleFiles(finalArgs.paths);
        return {
          content: [{ type: "text", text: results.join("\n---\n") }],
        };
      }
      case "write_file": {
        if (finalArgs.path === undefined) throw new Error("Missing 'path' for write_file");
        if (finalArgs.content === undefined) throw new Error("Missing 'content' for write_file");
        await writeFile(finalArgs.path, finalArgs.content);
        return {
          content: [{ type: "text", text: `Successfully wrote to ${finalArgs.path}` }],
        };
      }
      case "create_directory": {
        if (finalArgs.path === undefined) throw new Error("Missing 'path' for create_directory");
        await createDirectory(finalArgs.path);
        return {
          content: [{ type: "text", text: `Successfully created directory ${finalArgs.path}` }],
        };
      }
      case "list_directory": {
        if (finalArgs.path === undefined) throw new Error("Missing 'path' for list_directory");
        const entries = await listDirectory(finalArgs.path);
        return {
          content: [{ type: "text", text: entries.join('\n') }],
        };
      }
      case "move_file": {
        if (finalArgs.source === undefined) throw new Error("Missing 'source' for move_file");
        if (finalArgs.destination === undefined) throw new Error("Missing 'destination' for move_file");
        await moveFile(finalArgs.source, finalArgs.destination);
        return {
          content: [{ type: "text", text: `Successfully moved ${finalArgs.source} to ${finalArgs.destination}` }],
        };
      }
      case "search_files": {
        if (finalArgs.path === undefined) throw new Error("Missing 'path' for search_files");
        if (finalArgs.pattern === undefined) throw new Error("Missing 'pattern' for search_files");
        const results = await searchFiles(finalArgs.path, finalArgs.pattern);
        return {
          content: [{ type: "text", text: results.length > 0 ? results.join('\n') : "No matches found" }],
        };
      }
      case "search_code": {
        if (finalArgs.path === undefined) throw new Error("Missing 'path' for search_code");
        if (finalArgs.pattern === undefined) throw new Error("Missing 'pattern' for search_code");
        const results = await searchTextInFiles({
          rootPath: finalArgs.path,
          pattern: finalArgs.pattern,
          filePattern: finalArgs.filePattern,
          ignoreCase: finalArgs.ignoreCase,
          maxResults: finalArgs.maxResults,
          includeHidden: finalArgs.includeHidden,
          contextLines: finalArgs.contextLines,
        });

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: "No matches found" }],
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
        if (finalArgs.path === undefined) throw new Error("Missing 'path' for get_file_info");
        const info = await getFileInfo(finalArgs.path);
        return {
          content: [{ 
            type: "text", 
            text: Object.entries(info)
              .map(([key, value]) => `${key}: ${value}`)
              .join('\n') 
          }],
        };
      }
      case "list_allowed_directories": {
        const directories = listAllowedDirectories();
        return {
          content: [{ 
            type: "text", 
            text: `Allowed directories:\n${directories.join('\n')}` 
          }],
        };
      }

      default:
        throw new Error(`Unknown subtool: ${subtool}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // We can't reference subtool here if it might not be defined
    console.error(`Error processing tool call '${request.params.name}':`, error);
    return {
      content: [{ type: "text", text: `Error: ${errorMessage}` }],
      isError: true,
    };
  }
});