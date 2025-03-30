import { z } from "zod";

// Terminal tools schemas
export const ExecuteCommandArgsSchema = z.object({
  command: z.string(),
  timeout_ms: z.number().optional(),
});

export const ReadOutputArgsSchema = z.object({
  pid: z.number(),
});

export const ForceTerminateArgsSchema = z.object({
  pid: z.number(),
});

export const ListSessionsArgsSchema = z.object({});

export const KillProcessArgsSchema = z.object({
  pid: z.number(),
});

export const BlockCommandArgsSchema = z.object({
  command: z.string(),
});

export const UnblockCommandArgsSchema = z.object({
  command: z.string(),
});

// Filesystem tools schemas
export const ReadFileArgsSchema = z.object({
  path: z.string(),
});

export const ReadMultipleFilesArgsSchema = z.object({
  paths: z.array(z.string()),
});

export const WriteFileArgsSchema = z.object({
  path: z.string(),
  content: z.string(),
});

export const CreateDirectoryArgsSchema = z.object({
  path: z.string(),
});

export const ListDirectoryArgsSchema = z.object({
  path: z.string(),
});

export const MoveFileArgsSchema = z.object({
  source: z.string(),
  destination: z.string(),
});

export const SearchFilesArgsSchema = z.object({
  path: z.string(),
  pattern: z.string(),
});

export const GetFileInfoArgsSchema = z.object({
  path: z.string(),
});

// Search tools schema
export const SearchCodeArgsSchema = z.object({
  path: z.string(),
  pattern: z.string(),
  filePattern: z.string().optional(),
  ignoreCase: z.boolean().optional(),
  maxResults: z.number().optional(),
  includeHidden: z.boolean().optional(),
  contextLines: z.number().optional(),
});

// Edit tools schemas
export const EditBlockArgsSchema = z.object({
  blockContent: z.string(),
});

// Define the YOLO DesktopCommanderArgs schema
// This will be used for grouped and YOLO modes
export const DesktopCommanderArgsSchema = z.object({
  // Required subtool field to specify which operation to perform
  subtool: z.enum([
    // List ALL original tool names
    'execute_command', 'read_output', 'force_terminate', 'list_sessions',
    'list_processes', 'kill_process', 'block_command', 'unblock_command',
    'list_blocked_commands', 'read_file', 'read_multiple_files',
    'write_file', 'create_directory', 'list_directory', 'move_file',
    'search_files', 'search_code', 'get_file_info', 'list_allowed_directories',
    'edit_block'
  ]),

  // Add ALL optional parameters from ALL individual schemas above
  command: z.string().optional(),
  timeout_ms: z.number().optional(),
  pid: z.number().optional(),
  path: z.string().optional(),
  paths: z.array(z.string()).optional(),
  content: z.string().optional(),
  source: z.string().optional(),
  destination: z.string().optional(),
  pattern: z.string().optional(),
  filePattern: z.string().optional(),
  ignoreCase: z.boolean().optional(),
  maxResults: z.number().optional(),
  includeHidden: z.boolean().optional(),
  contextLines: z.number().optional(),
  blockContent: z.string().optional()
});

// Define the type for the YOLO schema
export type DesktopCommanderArgs = z.infer<typeof DesktopCommanderArgsSchema>;
