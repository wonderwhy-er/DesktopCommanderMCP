import { z } from "zod";

// Config tools schemas
export const GetConfigArgsSchema = z.object({});

export const SetConfigValueArgsSchema = z.object({
  key: z.string(),
  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.string()),
    z.null(),
  ]),
});

// Empty schemas
export const ListProcessesArgsSchema = z.object({});

// Terminal tools schemas
export const StartProcessArgsSchema = z.object({
  command: z.string(),
  timeout_ms: z.number(),
  shell: z.string().optional(),
  verbose_timing: z.boolean().optional(),
});

export const ReadProcessOutputArgsSchema = z.object({
  pid: z.number(),
  timeout_ms: z.number().optional(),
  verbose_timing: z.boolean().optional(),
});

export const ForceTerminateArgsSchema = z.object({
  pid: z.number(),
});

export const ListSessionsArgsSchema = z.object({});

export const KillProcessArgsSchema = z.object({
  pid: z.number(),
});

// Filesystem tools schemas
export const ReadFileArgsSchema = z.object({
  path: z.string(),
  isUrl: z.boolean().optional().default(false),
  offset: z.number().optional().default(0),
  length: z.number().optional().default(1000),
});

export const ReadMultipleFilesArgsSchema = z.object({
  paths: z.array(z.string()),
});

export const WriteFileArgsSchema = z.object({
  path: z.string(),
  content: z.string(),
  mode: z.enum(['rewrite', 'append']).default('rewrite'),
});

export const CreateDirectoryArgsSchema = z.object({
  path: z.string(),
});

export const ListDirectoryArgsSchema = z.object({
  path: z.string(),
  depth: z.number().optional().default(2),
});

export const MoveFileArgsSchema = z.object({
  source: z.string(),
  destination: z.string(),
});

export const GetFileInfoArgsSchema = z.object({
  path: z.string(),
});

// Edit tools schema
export const EditBlockArgsSchema = z.object({
  file_path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
  expected_replacements: z.number().optional().default(1),
});

// Send input to process schema
export const InteractWithProcessArgsSchema = z.object({
  pid: z.number(),
  input: z.string(),
  timeout_ms: z.number().optional(),
  wait_for_prompt: z.boolean().optional(),
  verbose_timing: z.boolean().optional(),
});

// Usage stats schema
export const GetUsageStatsArgsSchema = z.object({});

// Feedback tool schema - no pre-filled parameters, all user input
export const GiveFeedbackArgsSchema = z.object({
  // No parameters needed - form will be filled manually by user
  // Only auto-filled hidden fields remain:
  // - tool_call_count (auto)
  // - days_using (auto) 
  // - platform (auto)
  // - client_id (auto)
});

// Search schemas (renamed for natural language)
export const StartSearchArgsSchema = z.object({
  path: z.string(),
  pattern: z.string(),
  searchType: z.enum(['files', 'content']).default('files'),
  filePattern: z.string().optional(),
  ignoreCase: z.boolean().optional().default(true),
  maxResults: z.number().optional(),
  includeHidden: z.boolean().optional().default(false),
  contextLines: z.number().optional().default(5),
  timeout_ms: z.number().optional(), // Match process naming convention
  earlyTermination: z.boolean().optional(), // Stop search early when exact filename match is found (default: true for files, false for content)
  literalSearch: z.boolean().optional().default(false), // Force literal string matching (-F flag) instead of regex
});

export const GetMoreSearchResultsArgsSchema = z.object({
  sessionId: z.string(),
  offset: z.number().optional().default(0),    // Same as file reading
  length: z.number().optional().default(100),  // Same as file reading (but smaller default)
});

export const StopSearchArgsSchema = z.object({
  sessionId: z.string(),
});

export const ListSearchesArgsSchema = z.object({});

// Prompts tool schema
export const GetPromptsArgsSchema = z.object({
  action: z.enum(['list_categories', 'list_prompts', 'get_prompt']),
  category: z.string().optional(),
  promptId: z.string().optional(),
});

// Tool history schema
export const GetRecentToolCallsArgsSchema = z.object({
  maxResults: z.number().min(1).max(1000).optional().default(50),
  toolName: z.string().optional(),
  since: z.string().datetime().optional(),
});