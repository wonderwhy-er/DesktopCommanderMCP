import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListPromptsRequestSchema,
  type CallToolRequest,
} from "@modelcontextprotocol/sdk/types.js";

// Define interfaces for missing SDK types
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: any;
  [key: string]: unknown; // Add index signature for compatibility
}

interface ListToolsResponse {
  tools: ToolDefinition[];
  [key: string]: unknown; // Add index signature for compatibility
}
import { zodToJsonSchema } from "zod-to-json-schema";
import { commandManager } from './command-manager.js';
import { z } from "zod";
import {
  // Import the unified schema
  DesktopCommanderArgsSchema,
  type DesktopCommanderArgs,

  // Keep individual schemas for reference
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

// Define types for Mode and Permission
export type Mode = 'granular' | 'grouped' | 'unified';
export type Permission = string; // Changed to string to support comma-separated lists
export type PermissionPreset = 'read' | 'write' | 'execute' | 'all' | 'none';

// Define tool categories
export const ToolCategories: Record<string, 'Read' | 'Write' | 'Execute'> = {
  get_file_info: 'Read',
  list_allowed_directories: 'Read',
  list_blocked_commands: 'Read',
  list_directory: 'Read',
  list_processes: 'Read',
  list_sessions: 'Read',
  read_file: 'Read',
  read_multiple_files: 'Read',
  read_output: 'Read',
  search_code: 'Read',
  search_files: 'Read',
  block_command: 'Write',
  create_directory: 'Write',
  edit_block: 'Write',
  move_file: 'Write',
  unblock_command: 'Write',
  write_file: 'Write',
  execute_command: 'Execute',
  force_terminate: 'Execute',
  kill_process: 'Execute',
};

// Helper function to check permissions
function isSubtoolAllowed(subtool: string, permissionStr: Permission): boolean {
  // Parse the comma-separated permission string
  const permissions = permissionStr.split(',').map(p => p.trim().toLowerCase());

  // Quick checks for special cases
  if (permissions.includes('none')) return false;
  if (permissions.includes('all') && !permissions.some(p => p.startsWith('-'))) return true;

  // If the subtool is directly mentioned, it's allowed
  if (permissions.includes(subtool.toLowerCase())) return true;

  // Get the category of the subtool
  const category = ToolCategories[subtool];
  if (!category) return false; // Unknown subtool

  // Check if the category is allowed
  const categoryLower = category.toLowerCase();
  if (permissions.includes(categoryLower)) return true;

  // Handle negation with 'all,-category' format
  if (permissions.includes('all')) {
    // Get all negations (items starting with -)
    const negations = permissions
      .filter(p => p.startsWith('-'))
      .map(p => p.substring(1).toLowerCase());

    // If the category or subtool is negated, it's not allowed
    if (negations.includes(categoryLower) || negations.includes(subtool.toLowerCase())) {
      return false;
    }

    // Otherwise it's allowed by the 'all' permission
    return true;
  }

  // Handle specific permission values
  if (permissionStr === 'execute') return category === 'Read' || category === 'Execute';

  // Handle individual category permissions
  const hasRead = permissions.includes('read');
  const hasWrite = permissions.includes('write');
  const hasExecute = permissions.includes('execute');

  if (hasRead && hasWrite) {
    return category === 'Read' || category === 'Write';
  }

  if (hasRead) return category === 'Read';
  if (hasWrite) return category === 'Write';
  if (hasExecute) return category === 'Execute';

  return false;
}

// Define all tools with their metadata
const ALL_SUBTOOLS_METADATA: Record<string, { description: string, schema: z.ZodType<any> }> = {
  execute_command: {
    description: "Execute a terminal command with timeout. Command will continue running in background if it doesn't complete within timeout.",
    schema: ExecuteCommandArgsSchema,
  },
  read_output: {
    description: "Read new output from a running terminal session.",
    schema: ReadOutputArgsSchema,
  },
  force_terminate: {
    description: "Force terminate a running terminal session.",
    schema: ForceTerminateArgsSchema,
  },
  list_sessions: {
    description: "List all active terminal sessions.",
    schema: ListSessionsArgsSchema,
  },
  list_processes: {
    description: "List all running processes. Returns process information including PID, command name, CPU usage, and memory usage.",
    schema: z.object({}),
  },
  kill_process: {
    description: "Terminate a running process by PID. Use with caution as this will forcefully terminate the specified process.",
    schema: KillProcessArgsSchema,
  },
  block_command: {
    description: "Add a command to the blacklist. Once blocked, the command cannot be executed until unblocked.",
    schema: BlockCommandArgsSchema,
  },
  unblock_command: {
    description: "Remove a command from the blacklist. Once unblocked, the command can be executed normally.",
    schema: UnblockCommandArgsSchema,
  },
  list_blocked_commands: {
    description: "List all currently blocked commands.",
    schema: z.object({}),
  },
  read_file: {
    description: "Read the complete contents of a file from the file system. Handles various text encodings and provides detailed error messages if the file cannot be read. Only works within allowed directories.",
    schema: ReadFileArgsSchema,
  },
  read_multiple_files: {
    description: "Read the contents of multiple files simultaneously. Each file's content is returned with its path as a reference. Failed reads for individual files won't stop the entire operation. Only works within allowed directories.",
    schema: ReadMultipleFilesArgsSchema,
  },
  write_file: {
    description: "Completely replace file contents. Best for large changes (>20% of file) or when edit_block fails. Use with caution as it will overwrite existing files. Only works within allowed directories.",
    schema: WriteFileArgsSchema,
  },
  create_directory: {
    description: "Create a new directory or ensure a directory exists. Can create multiple nested directories in one operation. Only works within allowed directories.",
    schema: CreateDirectoryArgsSchema,
  },
  list_directory: {
    description: "Get a detailed listing of all files and directories in a specified path. Results distinguish between files and directories with [FILE] and [DIR] prefixes. Only works within allowed directories.",
    schema: ListDirectoryArgsSchema,
  },
  move_file: {
    description: "Move or rename files and directories. Can move files between directories and rename them in a single operation. Both source and destination must be within allowed directories.",
    schema: MoveFileArgsSchema,
  },
  search_files: {
    description: "Recursively search for files and directories matching a pattern. Searches through all subdirectories from the starting path. Only searches within allowed directories.",
    schema: SearchFilesArgsSchema,
  },
  search_code: {
    description: "Search for text/code patterns within file contents using ripgrep. Fast and powerful search similar to VS Code search functionality. Supports regular expressions, file pattern filtering, and context lines. Only searches within allowed directories.",
    schema: SearchCodeArgsSchema,
  },
  get_file_info: {
    description: "Retrieve detailed metadata about a file or directory including size, creation time, last modified time, permissions, and type. Only works within allowed directories.",
    schema: GetFileInfoArgsSchema,
  },
  list_allowed_directories: {
    description: "Returns the list of directories that this server is allowed to access.",
    schema: z.object({}),
  },
  edit_block: {
    description: "Apply surgical text replacements to files. Best for small changes (<20% of file size). Multiple blocks can be used for separate changes. Will verify changes after application. Format: filepath, then <<<<<<< SEARCH, content to find, =======, new content, >>>>>>> REPLACE.",
    schema: EditBlockArgsSchema,
  },
};

export class DesktopCommanderServer extends Server {
  private currentMode: Mode = 'granular'; // Default mode
  private currentPermission: Permission = 'all'; // Default permission

  constructor() {
    super(
      {
        name: "desktop-commander", // Keep the original server name
        version: VERSION,
      },
      {
        capabilities: {
          tools: {},
          resources: {},  // Add empty resources capability
          prompts: {},    // Add empty prompts capability
        },
      }
    );

    // Register the request handlers
    this.setRequestHandler(ListToolsRequestSchema, this.handleListTools);
    this.setRequestHandler(CallToolRequestSchema, async (request) => {
      return this.handleCallTool(request);
    });

    // Add handler for resources/list method
    this.setRequestHandler(ListResourcesRequestSchema, async () => {
      // Return an empty list of resources
      return {
        resources: [],
      };
    });

    // Add handler for prompts/list method
    this.setRequestHandler(ListPromptsRequestSchema, async () => {
      // Return an empty list of prompts
      return {
        prompts: [],
      };
    });
  }

  // Method to set the mode
  public setMode(mode: Mode): void {
    this.currentMode = mode;
    console.error(`DesktopCommander MCP Mode set to: ${mode}`); // Log mode changes to stderr
  }

  // Method to set the permission level
  public setPermission(permission: Permission): void {
    this.currentPermission = permission;
    console.error(`DesktopCommander MCP Permission set to: ${permission}`); // Log permission changes to stderr
  }

  // --- Handler for ListTools ---
  private handleListTools = async (request: any, extra: any) => {
    const allowedSubtools = Object.keys(ALL_SUBTOOLS_METADATA).filter(subtool =>
      isSubtoolAllowed(subtool, this.currentPermission)
    );

    let tools: any[] = [];
    const unifiedSchemaJson = zodToJsonSchema(DesktopCommanderArgsSchema);

    switch (this.currentMode) {
      case 'granular':
        tools = allowedSubtools.map(subtool => {
          // Get the tool category for additional context
          const category = ToolCategories[subtool] || '';

          return {
            name: subtool, // Use the actual subtool name in granular mode
            description: `${ALL_SUBTOOLS_METADATA[subtool].description} (${category} Operation)`,
            inputSchema: zodToJsonSchema(ALL_SUBTOOLS_METADATA[subtool].schema),
          };
        });
        break;

      case 'grouped':
        const grouped: Record<string, string[]> = { Read: [], Write: [], Execute: [] };
        allowedSubtools.forEach(subtool => {
          const category = ToolCategories[subtool];
          if (category) {
            grouped[category].push(subtool);
          }
        });

        Object.entries(grouped).forEach(([category, subtoolsInCategory]) => {
          if (subtoolsInCategory.length > 0) {
            // Use the lowercase category name as the tool name
            const toolName = category.toLowerCase();
            // Create detailed descriptions for each subtool in this category
            const subtoolDetails = subtoolsInCategory.map(subtool =>
              `• ${subtool}: ${ALL_SUBTOOLS_METADATA[subtool].description}`
            ).join('\n');

            tools.push({
              name: toolName,
              description: `Perform ${category} operations with specialized tools. Provides access to ${category.toLowerCase()}-related functionality with appropriate permissions and safety controls.\n\nAvailable subtools:\n${subtoolDetails}`,
              inputSchema: unifiedSchemaJson,
            });
          }
        });
        break;

      case 'unified':
        if (allowedSubtools.length > 0) {
          // Create a detailed description with all subtools and their descriptions
          const subtoolDescriptions = allowedSubtools.map(subtool =>
            `• ${subtool}: ${ALL_SUBTOOLS_METADATA[subtool].description}`
          ).join('\n');

          tools.push({
            name: "command",
            description: `Comprehensive tool for terminal, filesystem, and process management. Provides access to file operations, command execution, process control, and code search through a unified interface. Use 'subtool' parameter to specify the operation.\n\nAvailable subtools:\n${subtoolDescriptions}`,
            inputSchema: unifiedSchemaJson,
          });
        }
        break;
    }

    return { tools };
  }

  // --- Handler for CallTool ---
  private handleCallTool = async (request: CallToolRequest) => {
    // Check if the tool name is valid (desktop_commander, command, a known subtool, or a category name)
    const isValidTool = request.params.name === "desktop_commander" ||
                         request.params.name === "command" ||
                         Object.keys(ALL_SUBTOOLS_METADATA).includes(request.params.name) ||
                         ["read", "write", "execute"].includes(request.params.name);

    if (!isValidTool) {
      return {
        content: [{ type: "text", text: `Error: Unknown tool name '${request.params.name}'.` }],
        isError: true,
      };
    }

    // Check if 'none' permission is set
    if (this.currentPermission === 'none' || this.currentPermission.split(',').includes('none')) {
      return {
        content: [{ type: "text", text: `Error: Permission denied. No tools are allowed with current permission setting '${this.currentPermission}'.` }],
        isError: true,
      };
    }

    try {
      let subtool: string;
      let parsedArgs: any;

      // Handle different tool name formats
      if (request.params.name === "desktop_commander" ||
          request.params.name === "command" ||
          ["read", "write", "execute"].includes(request.params.name)) {
        // Using the unified tool or category-based tool, extract subtool from arguments
        const parsedUnified = DesktopCommanderArgsSchema.safeParse(request.params.arguments);
        if (!parsedUnified.success) {
          return {
            content: [{ type: "text", text: `Error: Invalid arguments: ${parsedUnified.error.message}` }],
            isError: true,
          };
        }
        subtool = parsedUnified.data.subtool;

        // For category-based tools, verify that the subtool belongs to the correct category
        if (["read", "write", "execute"].includes(request.params.name)) {
          const expectedCategory = request.params.name.charAt(0).toUpperCase() + request.params.name.slice(1);
          const actualCategory = ToolCategories[subtool];

          if (actualCategory !== expectedCategory) {
            return {
              content: [{
                type: "text",
                text: `Error: Subtool '${subtool}' cannot be used with the '${request.params.name}' tool. It belongs to the '${actualCategory}' category.`
              }],
              isError: true,
            };
          }
        }

        parsedArgs = { success: true, data: parsedUnified.data };
      } else {
        // Using a granular tool, the name is the subtool
        subtool = request.params.name;
        // Parse with the specific schema for this subtool
        if (ALL_SUBTOOLS_METADATA[subtool]) {
          parsedArgs = ALL_SUBTOOLS_METADATA[subtool].schema.safeParse(request.params.arguments);

          if (!parsedArgs.success) {
            return {
              content: [{ type: "text", text: `Error: Invalid arguments: ${parsedArgs.error.message}` }],
              isError: true,
            };
          }

          // For granular tools, we need to add the subtool back into the parsed data
          parsedArgs.data = {
            ...parsedArgs.data,
            subtool: subtool
          };
        } else {
          return {
            content: [{ type: "text", text: `Error: Unknown subtool '${subtool}'` }],
            isError: true,
          };
        }
      }

      // --- Permission Check ---
      if (!isSubtoolAllowed(subtool, this.currentPermission)) {
        return {
          content: [{ type: "text", text: `Error: Permission denied for subtool '${subtool}' with current permission setting '${this.currentPermission}'.` }],
          isError: true,
        };
      }

      // --- Subtool Dispatch ---
      switch (subtool) {
        // Terminal tools
        case "execute_command": {
          if (!parsedArgs.data.command) {
            throw new Error("Missing required 'command' parameter for execute_command");
          }
          return executeCommand({
            command: parsedArgs.data.command,
            timeout_ms: parsedArgs.data.timeout_ms
          });
        }
        case "read_output": {
          if (!parsedArgs.data.pid) {
            throw new Error("Missing required 'pid' parameter for read_output");
          }
          return readOutput({
            pid: parsedArgs.data.pid
          });
        }
        case "force_terminate": {
          if (!parsedArgs.data.pid) {
            throw new Error("Missing required 'pid' parameter for force_terminate");
          }
          return forceTerminate({
            pid: parsedArgs.data.pid
          });
        }
        case "list_sessions":
          return listSessions();

        // Process tools
        case "list_processes":
          return listProcesses();
        case "kill_process": {
          if (!parsedArgs.data.pid) {
            throw new Error("Missing required 'pid' parameter for kill_process");
          }
          return killProcess({
            pid: parsedArgs.data.pid
          });
        }

        // Command Blocking tools
        case "block_command": {
          if (!parsedArgs.data.command) {
            throw new Error("Missing required 'command' parameter for block_command");
          }
          const blockResult = await commandManager.blockCommand(parsedArgs.data.command);
          return { content: [{ type: "text", text: String(blockResult) }] };
        }
        case "unblock_command": {
          if (!parsedArgs.data.command) {
            throw new Error("Missing required 'command' parameter for unblock_command");
          }
          const unblockResult = await commandManager.unblockCommand(parsedArgs.data.command);
          return { content: [{ type: "text", text: String(unblockResult) }] };
        }
        case "list_blocked_commands": {
          const blockedCommands = await commandManager.listBlockedCommands();
          return { content: [{ type: "text", text: blockedCommands.join('\n') || "No commands are blocked." }] };
        }

        // Filesystem tools
        case "read_file": {
          if (!parsedArgs.data.path) {
            throw new Error("Missing required 'path' parameter for read_file");
          }
          const content = await readFile(parsedArgs.data.path);
          return { content: [{ type: "text", text: content }] };
        }
        case "read_multiple_files": {
          if (!parsedArgs.data.paths) {
            throw new Error("Missing required 'paths' parameter for read_multiple_files");
          }
          const results = await readMultipleFiles(parsedArgs.data.paths);
          return { content: [{ type: "text", text: results.join("\n---\n") }] };
        }
        case "write_file": {
          if (!parsedArgs.data.path) {
            throw new Error("Missing required 'path' parameter for write_file");
          }
          if (!parsedArgs.data.content) {
            throw new Error("Missing required 'content' parameter for write_file");
          }
          await writeFile(parsedArgs.data.path, parsedArgs.data.content);
          return { content: [{ type: "text", text: `Successfully wrote to ${parsedArgs.data.path}` }] };
        }
        case "create_directory": {
          if (!parsedArgs.data.path) {
            throw new Error("Missing required 'path' parameter for create_directory");
          }
          await createDirectory(parsedArgs.data.path);
          return { content: [{ type: "text", text: `Successfully created directory ${parsedArgs.data.path}` }] };
        }
        case "list_directory": {
          if (!parsedArgs.data.path) {
            throw new Error("Missing required 'path' parameter for list_directory");
          }
          const entries = await listDirectory(parsedArgs.data.path);
          return { content: [{ type: "text", text: entries.join('\n') }] };
        }
        case "move_file": {
          if (!parsedArgs.data.source) {
            throw new Error("Missing required 'source' parameter for move_file");
          }
          if (!parsedArgs.data.destination) {
            throw new Error("Missing required 'destination' parameter for move_file");
          }
          await moveFile(parsedArgs.data.source, parsedArgs.data.destination);
          return { content: [{ type: "text", text: `Successfully moved ${parsedArgs.data.source} to ${parsedArgs.data.destination}` }] };
        }
        case "search_files": {
          if (!parsedArgs.data.path) {
            throw new Error("Missing required 'path' parameter for search_files");
          }
          if (!parsedArgs.data.pattern) {
            throw new Error("Missing required 'pattern' parameter for search_files");
          }
          const results = await searchFiles(parsedArgs.data.path, parsedArgs.data.pattern);
          return { content: [{ type: "text", text: results.length > 0 ? results.join('\n') : "No matches found" }] };
        }
        case "search_code": {
          if (!parsedArgs.data.path) {
            throw new Error("Missing required 'path' parameter for search_code");
          }
          if (!parsedArgs.data.pattern) {
            throw new Error("Missing required 'pattern' parameter for search_code");
          }

          const results = await searchTextInFiles({
            rootPath: parsedArgs.data.path,
            pattern: parsedArgs.data.pattern,
            filePattern: parsedArgs.data.filePattern,
            ignoreCase: parsedArgs.data.ignoreCase,
            maxResults: parsedArgs.data.maxResults,
            includeHidden: parsedArgs.data.includeHidden,
            contextLines: parsedArgs.data.contextLines,
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
          if (!parsedArgs.data.path) {
            throw new Error("Missing required 'path' parameter for get_file_info");
          }
          const info = await getFileInfo(parsedArgs.data.path);
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

        // Edit tools
        case "edit_block": {
          if (!parsedArgs.data.blockContent) {
            throw new Error("Missing required 'blockContent' parameter for edit_block");
          }
          const { filePath, searchReplace } = await parseEditBlock(parsedArgs.data.blockContent);
          await performSearchReplace(filePath, searchReplace);
          return { content: [{ type: "text", text: `Successfully applied edit to ${filePath}` }] };
        }

        default:
          // This case should ideally not be reached if Zod schema is exhaustive
          return {
            content: [{ type: "text", text: `Error: Unknown subtool '${subtool}'` }],
            isError: true,
          };
      }
    } catch (error) {
      console.error(`Error processing subtool:`, error); // Log error details
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Error: ${errorMessage}` }],
        isError: true,
      };
    }
  }
}

// Instantiate the server
export const server = new DesktopCommanderServer();
